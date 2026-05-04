use unicli_shared::SidecarRequest;

use crate::errors::{backend_unavailable, HandlerResult, UiaError};
use crate::invoke::focus_top_level_window;
#[cfg(target_os = "windows")]
use crate::tree::resolve_live_descendant_element;
use crate::tree::{
    enumerate_top_level_windows, resolve_descendant_element_ref, resolve_top_level_window_ref,
    ElementRecord, State, WindowRecord,
};

#[cfg(target_os = "windows")]
const INPUT_KEYBOARD: u32 = 1;
#[cfg(target_os = "windows")]
const INPUT_MOUSE: u32 = 0;
const KEYEVENTF_EXTENDEDKEY: u32 = 0x0001;
const KEYEVENTF_KEYUP: u32 = 0x0002;
const KEYEVENTF_UNICODE: u32 = 0x0004;
const KEYEVENTF_SCANCODE: u32 = 0x0008;
const MOUSEEVENTF_WHEEL: u32 = 0x0800;
const MOUSEEVENTF_HWHEEL: u32 = 0x1000;
const EXTENDED_SCANCODE_PREFIX: u16 = 0x0100;
const WHEEL_DELTA: i32 = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyEventPlan {
    scan_code: u16,
    key_up: bool,
}

impl KeyEventPlan {
    fn down(scan_code: u16) -> Self {
        Self {
            scan_code,
            key_up: false,
        }
    }

    fn up(scan_code: u16) -> Self {
        Self {
            scan_code,
            key_up: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KeyboardInputRecord {
    scan_code: u16,
    flags: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MouseInputRecord {
    mouse_data: i32,
    flags: u32,
}

pub fn handle_press(request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "windows") {
        return Err(backend_unavailable());
    }

    let combo = read_combo(&request.params)?;
    let plan = scancode_plan_for_combo(&combo).map_err(UiaError::invalid_input)?;
    dispatch_scancode_plan(&plan)?;
    Ok(serde_json::json!({
        "pressed": true,
        "combo": combo,
        "events": plan.len()
    }))
}

pub fn handle_scroll(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "windows") {
        return Err(backend_unavailable());
    }

    let stable = read_stable_ref(&request.params)?;
    let direction = read_scroll_direction(&request.params);
    let amount = read_scroll_amount(&request.params);
    let windows = enumerate_top_level_windows()?;
    if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
        focus_top_level_window(window)?;
        if try_native_scroll_descendant(window, &stable, &direction, amount)? {
            return Ok(scroll_response_for_descendant(
                window,
                element,
                &stable,
                &path,
                &direction,
                amount,
                "uia_scroll_pattern",
            ));
        }
        dispatch_mouse_input_records(&mouse_input_records_for_scroll(&direction, amount)?)?;
        return Ok(scroll_response_for_descendant(
            window,
            element,
            &stable,
            &path,
            &direction,
            amount,
            "descendant_sendinput",
        ));
    }
    let window = resolve_top_level_window_ref(&windows, &stable)
        .ok_or_else(|| UiaError::no_element(stable.clone()))?;
    focus_top_level_window(window)?;
    dispatch_mouse_input_records(&mouse_input_records_for_scroll(&direction, amount)?)?;
    Ok(scroll_response_for_window(
        window, &stable, &direction, amount,
    ))
}

pub(crate) fn send_text_input(text: &str) -> HandlerResult {
    dispatch_keyboard_input_records(&unicode_input_records_for_text(text))
}

fn read_combo(params: &serde_json::Value) -> Result<String, UiaError> {
    params
        .get("combo")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|combo| !combo.is_empty())
        .map(String::from)
        .ok_or_else(|| UiaError::invalid_input("uia_press requires a non-empty combo"))
}

fn read_stable_ref(params: &serde_json::Value) -> Result<String, UiaError> {
    params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.starts_with("desktop-uia:"))
        .map(str::to_string)
        .ok_or_else(|| {
            UiaError::invalid_input("uia_scroll requires a desktop-uia stable window ref")
        })
}

fn read_scroll_direction(params: &serde_json::Value) -> String {
    params
        .get("direction")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("down")
        .to_ascii_lowercase()
}

fn read_scroll_amount(params: &serde_json::Value) -> u32 {
    params
        .get("amount")
        .and_then(serde_json::Value::as_u64)
        .and_then(|amount| u32::try_from(amount).ok())
        .filter(|amount| *amount > 0)
        .unwrap_or(300)
}

fn scroll_response_for_window(
    window: &WindowRecord,
    stable: &str,
    direction: &str,
    amount: u32,
) -> serde_json::Value {
    serde_json::json!({
        "scrolled": true,
        "via": "top_level_window_sendinput",
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
        "direction": direction,
        "amount": amount,
    })
}

fn scroll_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    direction: &str,
    amount: u32,
    via: &str,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = serde_json::json!({
            "x": bounds.x,
            "y": bounds.y,
            "width": bounds.width,
            "height": bounds.height,
        });
    }
    serde_json::json!({
        "scrolled": true,
        "via": via,
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "direction": direction,
        "amount": amount,
    })
}

fn descendant_target_node(element: &ElementRecord, path: &str) -> serde_json::Value {
    let mut target = serde_json::json!({
        "role": element.role,
        "name": element.name,
        "path": path,
    });
    if let Some(value) = &element.value {
        target["value"] = serde_json::json!(value);
    }
    target
}

fn scancode_plan_for_combo(combo: &str) -> Result<Vec<KeyEventPlan>, String> {
    let mut modifier_codes = Vec::new();
    let mut key_code = None;

    for raw_part in combo.split('+') {
        let part = raw_part.trim().to_ascii_lowercase();
        let key = part.as_str();
        let code = scancode_for_key(key).ok_or_else(|| format!("unsupported key {key}"))?;
        if is_modifier(key) {
            modifier_codes.push(code);
        } else if key_code.replace(code).is_some() {
            return Err("combo contains multiple non-modifier keys".into());
        }
    }

    let key_code = key_code.ok_or_else(|| "combo must include a non-modifier key".to_string())?;
    let mut plan = Vec::with_capacity((modifier_codes.len() * 2) + 2);
    plan.extend(modifier_codes.iter().copied().map(KeyEventPlan::down));
    plan.push(KeyEventPlan::down(key_code));
    plan.push(KeyEventPlan::up(key_code));
    plan.extend(modifier_codes.iter().rev().copied().map(KeyEventPlan::up));
    Ok(plan)
}

fn dispatch_scancode_plan(plan: &[KeyEventPlan]) -> HandlerResult {
    dispatch_keyboard_input_records(&send_input_records_for_plan(plan))
}

fn send_input_records_for_plan(plan: &[KeyEventPlan]) -> Vec<KeyboardInputRecord> {
    plan.iter()
        .map(|event| {
            let mut flags = KEYEVENTF_SCANCODE;
            if event.key_up {
                flags |= KEYEVENTF_KEYUP;
            }
            if event.scan_code & EXTENDED_SCANCODE_PREFIX != 0 {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }
            KeyboardInputRecord {
                scan_code: event.scan_code & 0x00ff,
                flags,
            }
        })
        .collect()
}

fn unicode_input_records_for_text(text: &str) -> Vec<KeyboardInputRecord> {
    text.encode_utf16()
        .flat_map(|unit| {
            [
                KeyboardInputRecord {
                    scan_code: unit,
                    flags: KEYEVENTF_UNICODE,
                },
                KeyboardInputRecord {
                    scan_code: unit,
                    flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                },
            ]
        })
        .collect()
}

fn mouse_input_records_for_scroll(
    direction: &str,
    amount: u32,
) -> Result<Vec<MouseInputRecord>, UiaError> {
    let delta = wheel_delta_for_amount(amount);
    let record = match direction {
        "up" => MouseInputRecord {
            mouse_data: delta,
            flags: MOUSEEVENTF_WHEEL,
        },
        "down" => MouseInputRecord {
            mouse_data: -delta,
            flags: MOUSEEVENTF_WHEEL,
        },
        "right" => MouseInputRecord {
            mouse_data: delta,
            flags: MOUSEEVENTF_HWHEEL,
        },
        "left" => MouseInputRecord {
            mouse_data: -delta,
            flags: MOUSEEVENTF_HWHEEL,
        },
        other => {
            return Err(UiaError::invalid_input(format!(
                "unsupported scroll direction {other}; expected up, down, left, or right"
            )));
        }
    };
    Ok(vec![record])
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeScrollAmount {
    LargeDecrement,
    SmallDecrement,
    NoAmount,
    LargeIncrement,
    SmallIncrement,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NativeScrollPlan {
    horizontal: NativeScrollAmount,
    vertical: NativeScrollAmount,
}

#[cfg(any(target_os = "windows", test))]
fn native_scroll_plan(direction: &str, amount: u32) -> Result<NativeScrollPlan, UiaError> {
    let directional_amount = if amount <= WHEEL_DELTA as u32 {
        NativeScrollAmount::SmallIncrement
    } else {
        NativeScrollAmount::LargeIncrement
    };
    let decrement_amount = match directional_amount {
        NativeScrollAmount::SmallIncrement => NativeScrollAmount::SmallDecrement,
        NativeScrollAmount::LargeIncrement => NativeScrollAmount::LargeDecrement,
        _ => unreachable!("directional amount is always increment"),
    };
    let no_amount = NativeScrollAmount::NoAmount;
    match direction {
        "up" => Ok(NativeScrollPlan {
            horizontal: no_amount,
            vertical: decrement_amount,
        }),
        "down" => Ok(NativeScrollPlan {
            horizontal: no_amount,
            vertical: directional_amount,
        }),
        "left" => Ok(NativeScrollPlan {
            horizontal: decrement_amount,
            vertical: no_amount,
        }),
        "right" => Ok(NativeScrollPlan {
            horizontal: directional_amount,
            vertical: no_amount,
        }),
        other => Err(UiaError::invalid_input(format!(
            "unsupported scroll direction {other}; expected up, down, left, or right"
        ))),
    }
}

#[cfg(target_os = "windows")]
fn try_native_scroll_descendant(
    window: &WindowRecord,
    stable: &str,
    direction: &str,
    amount: u32,
) -> Result<bool, UiaError> {
    use windows::Win32::UI::Accessibility::{IUIAutomationScrollPattern, UIA_ScrollPatternId};

    let plan = native_scroll_plan(direction, amount)?;
    let element = match resolve_live_descendant_element(window, stable) {
        Ok(element) => element,
        Err(_) => return Ok(false),
    };
    let pattern = match unsafe {
        element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId)
    } {
        Ok(pattern) => pattern,
        Err(_) => return Ok(false),
    };
    Ok(unsafe {
        pattern.Scroll(
            windows_scroll_amount(plan.horizontal),
            windows_scroll_amount(plan.vertical),
        )
    }
    .is_ok())
}

#[cfg(not(target_os = "windows"))]
fn try_native_scroll_descendant(
    _window: &WindowRecord,
    _stable: &str,
    _direction: &str,
    _amount: u32,
) -> Result<bool, UiaError> {
    Ok(false)
}

#[cfg(target_os = "windows")]
fn windows_scroll_amount(
    amount: NativeScrollAmount,
) -> windows::Win32::UI::Accessibility::ScrollAmount {
    use windows::Win32::UI::Accessibility::{
        ScrollAmount_LargeDecrement, ScrollAmount_LargeIncrement, ScrollAmount_NoAmount,
        ScrollAmount_SmallDecrement, ScrollAmount_SmallIncrement,
    };

    match amount {
        NativeScrollAmount::LargeDecrement => ScrollAmount_LargeDecrement,
        NativeScrollAmount::SmallDecrement => ScrollAmount_SmallDecrement,
        NativeScrollAmount::NoAmount => ScrollAmount_NoAmount,
        NativeScrollAmount::LargeIncrement => ScrollAmount_LargeIncrement,
        NativeScrollAmount::SmallIncrement => ScrollAmount_SmallIncrement,
    }
}

fn wheel_delta_for_amount(amount: u32) -> i32 {
    let steps = amount.div_ceil(WHEEL_DELTA as u32).max(1);
    (steps as i32) * WHEEL_DELTA
}

#[cfg(target_os = "windows")]
fn dispatch_keyboard_input_records(records: &[KeyboardInputRecord]) -> HandlerResult {
    use std::mem::size_of;

    let inputs: Vec<win32::Input> = records
        .iter()
        .map(|record| win32::Input {
            input_type: INPUT_KEYBOARD,
            input: win32::InputUnion {
                keyboard: win32::KeyboardInput {
                    virtual_key: 0,
                    scan_code: record.scan_code,
                    flags: record.flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        })
        .collect();

    let inserted = unsafe {
        win32::SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<win32::Input>() as i32,
        )
    };
    if inserted == inputs.len() as u32 {
        return Ok(serde_json::json!({
            "events": inserted
        }));
    }

    Err(UiaError::permission(format!(
        "Windows SendInput inserted {inserted} of {} keyboard events: {}",
        inputs.len(),
        std::io::Error::last_os_error()
    )))
}

#[cfg(target_os = "windows")]
fn dispatch_mouse_input_records(records: &[MouseInputRecord]) -> HandlerResult {
    use std::mem::size_of;

    let inputs: Vec<win32::Input> = records
        .iter()
        .map(|record| win32::Input {
            input_type: INPUT_MOUSE,
            input: win32::InputUnion {
                mouse: win32::MouseInput {
                    dx: 0,
                    dy: 0,
                    mouse_data: record.mouse_data as u32,
                    flags: record.flags,
                    time: 0,
                    extra_info: 0,
                },
            },
        })
        .collect();

    let inserted = unsafe {
        win32::SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<win32::Input>() as i32,
        )
    };
    if inserted == inputs.len() as u32 {
        return Ok(serde_json::json!({
            "events": inserted
        }));
    }

    Err(UiaError::permission(format!(
        "Windows SendInput inserted {inserted} of {} mouse events: {}",
        inputs.len(),
        std::io::Error::last_os_error()
    )))
}

#[cfg(not(target_os = "windows"))]
fn dispatch_mouse_input_records(_records: &[MouseInputRecord]) -> HandlerResult {
    Err(backend_unavailable())
}

#[cfg(not(target_os = "windows"))]
fn dispatch_keyboard_input_records(_records: &[KeyboardInputRecord]) -> HandlerResult {
    Err(backend_unavailable())
}

fn is_modifier(key: &str) -> bool {
    matches!(
        key,
        "ctrl" | "control" | "shift" | "alt" | "option" | "cmd" | "command" | "win" | "windows"
    )
}

fn scancode_for_key(key: &str) -> Option<u16> {
    Some(match key {
        "ctrl" | "control" => 0x01d,
        "shift" => 0x02a,
        "alt" | "option" => 0x038,
        "cmd" | "command" | "win" | "windows" => 0x15b,
        "esc" | "escape" => 0x001,
        "1" => 0x002,
        "2" => 0x003,
        "3" => 0x004,
        "4" => 0x005,
        "5" => 0x006,
        "6" => 0x007,
        "7" => 0x008,
        "8" => 0x009,
        "9" => 0x00a,
        "0" => 0x00b,
        "backspace" => 0x00e,
        "tab" => 0x00f,
        "q" => 0x010,
        "w" => 0x011,
        "e" => 0x012,
        "r" => 0x013,
        "t" => 0x014,
        "y" => 0x015,
        "u" => 0x016,
        "i" => 0x017,
        "o" => 0x018,
        "p" => 0x019,
        "enter" | "return" => 0x01c,
        "a" => 0x01e,
        "s" => 0x01f,
        "d" => 0x020,
        "f" => 0x021,
        "g" => 0x022,
        "h" => 0x023,
        "j" => 0x024,
        "k" => 0x025,
        "l" => 0x026,
        "z" => 0x02c,
        "x" => 0x02d,
        "c" => 0x02e,
        "v" => 0x02f,
        "b" => 0x030,
        "n" => 0x031,
        "m" => 0x032,
        "space" => 0x039,
        "delete" => 0x153,
        _ => return None,
    })
}

#[cfg(target_os = "windows")]
mod win32 {
    #[repr(C)]
    pub struct Input {
        pub input_type: u32,
        pub input: InputUnion,
    }

    #[repr(C)]
    pub union InputUnion {
        pub keyboard: KeyboardInput,
        pub mouse: MouseInput,
    }

    #[derive(Clone, Copy)]
    #[repr(C)]
    pub struct KeyboardInput {
        pub virtual_key: u16,
        pub scan_code: u16,
        pub flags: u32,
        pub time: u32,
        pub extra_info: usize,
    }

    #[derive(Clone, Copy)]
    #[repr(C)]
    pub struct MouseInput {
        pub dx: i32,
        pub dy: i32,
        pub mouse_data: u32,
        pub flags: u32,
        pub time: u32,
        pub extra_info: usize,
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn SendInput(input_count: u32, inputs: *const Input, input_size: i32) -> u32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combo_plan_presses_modifiers_then_key_and_releases_in_reverse() {
        let plan = scancode_plan_for_combo("ctrl+shift+p").expect("combo plan");

        assert_eq!(
            plan,
            vec![
                KeyEventPlan::down(0x01d),
                KeyEventPlan::down(0x02a),
                KeyEventPlan::down(0x019),
                KeyEventPlan::up(0x019),
                KeyEventPlan::up(0x02a),
                KeyEventPlan::up(0x01d),
            ],
        );
    }

    #[test]
    fn combo_plan_supports_named_single_keys() {
        let plan = scancode_plan_for_combo("enter").expect("enter plan");

        assert_eq!(
            plan,
            vec![KeyEventPlan::down(0x01c), KeyEventPlan::up(0x01c)],
        );
    }

    #[test]
    fn combo_plan_rejects_unknown_keys() {
        let error = scancode_plan_for_combo("ctrl+hyper+p").expect_err("unknown key");

        assert!(error.contains("hyper"));
    }

    #[test]
    fn combo_plan_rejects_multiple_non_modifier_keys() {
        let error = scancode_plan_for_combo("ctrl+p+s").expect_err("ambiguous combo");

        assert!(error.contains("multiple"));
    }

    #[test]
    fn send_input_records_use_scancode_flags_and_extended_key_prefix() {
        let records =
            send_input_records_for_plan(&[KeyEventPlan::down(0x153), KeyEventPlan::up(0x153)]);

        assert_eq!(
            records,
            vec![
                KeyboardInputRecord {
                    scan_code: 0x053,
                    flags: KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY,
                },
                KeyboardInputRecord {
                    scan_code: 0x053,
                    flags: KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP,
                },
            ],
        );
    }

    #[test]
    fn unicode_input_records_use_utf16_units_and_keyup_pairs() {
        let records = unicode_input_records_for_text("A\u{1f642}");

        assert_eq!(
            records,
            vec![
                KeyboardInputRecord {
                    scan_code: 0x0041,
                    flags: KEYEVENTF_UNICODE,
                },
                KeyboardInputRecord {
                    scan_code: 0x0041,
                    flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                },
                KeyboardInputRecord {
                    scan_code: 0xd83d,
                    flags: KEYEVENTF_UNICODE,
                },
                KeyboardInputRecord {
                    scan_code: 0xd83d,
                    flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                },
                KeyboardInputRecord {
                    scan_code: 0xde42,
                    flags: KEYEVENTF_UNICODE,
                },
                KeyboardInputRecord {
                    scan_code: 0xde42,
                    flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                },
            ],
        );
    }

    #[test]
    fn scroll_input_records_use_wheel_axis_direction_and_amount() {
        let down = mouse_input_records_for_scroll("down", 300).expect("down scroll");
        let left = mouse_input_records_for_scroll("left", 120).expect("left scroll");

        assert_eq!(
            down,
            vec![MouseInputRecord {
                mouse_data: -360,
                flags: MOUSEEVENTF_WHEEL,
            }],
        );
        assert_eq!(
            left,
            vec![MouseInputRecord {
                mouse_data: -120,
                flags: MOUSEEVENTF_HWHEEL,
            }],
        );
    }

    #[test]
    fn native_scroll_plan_maps_direction_and_amount_to_uia_scroll_amounts() {
        let down = native_scroll_plan("down", 300).expect("down native scroll");
        let right = native_scroll_plan("right", 120).expect("right native scroll");

        assert_eq!(
            down,
            NativeScrollPlan {
                horizontal: NativeScrollAmount::NoAmount,
                vertical: NativeScrollAmount::LargeIncrement,
            },
        );
        assert_eq!(
            right,
            NativeScrollPlan {
                horizontal: NativeScrollAmount::SmallIncrement,
                vertical: NativeScrollAmount::NoAmount,
            },
        );
    }

    #[test]
    fn scroll_response_can_report_native_descendant_scroll_pattern() {
        let response = scroll_response_for_descendant(
            &WindowRecord {
                hwnd: "0x2a".into(),
                pid: 42,
                title: "Settings".into(),
                children: vec![],
            },
            &crate::tree::ElementRecord {
                role: "Pane".into(),
                name: "Advanced".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]/Pane[0]",
            "Window[0]/Pane[0]",
            "down",
            300,
            "uia_scroll_pattern",
        );

        assert_eq!(response["scrolled"], true);
        assert_eq!(response["via"], "uia_scroll_pattern");
        assert_eq!(response["target"]["role"], "Pane");
    }
}
