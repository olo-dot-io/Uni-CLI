use std::process::Command;

use unicli_shared::SidecarRequest;

use crate::errors::{HandlerResult, UiaError};
use crate::input::send_text_input;
#[cfg(target_os = "windows")]
use crate::tree::resolve_live_descendant_element;
use crate::tree::{
    enumerate_top_level_windows, resolve_descendant_element_ref, resolve_top_level_window_ref,
    ElementBounds, ElementRecord, State, WindowRecord,
};

pub fn handle_invoke(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let stable = read_stable_ref(&request.params, "uia_invoke")?;
    let windows = enumerate_top_level_windows()?;
    if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
        focus_top_level_window(window)?;
        if let Some(action) = try_native_invoke_descendant(window, &stable)? {
            return Ok(invoke_response_for_descendant(
                window,
                element,
                &stable,
                &path,
                native_invoke_action_via(action),
            ));
        }
        let bounds = require_descendant_bounds(element, &stable)?;
        post_click_descendant(window, bounds)?;
        return Ok(invoke_response_for_descendant(
            window,
            element,
            &stable,
            &path,
            "post_message",
        ));
    }
    let stable = require_top_level_stable_ref(stable)?;
    let window = resolve_top_level_window_ref(&windows, &stable)
        .ok_or_else(|| UiaError::no_element(stable.clone()))?;
    focus_top_level_window(window)?;
    Ok(invoke_response_for_window(window, &stable))
}

pub fn handle_set_value(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let stable = read_stable_ref(&request.params, "uia_set_value")?;
    let text = read_text_value(&request.params)?;
    let windows = enumerate_top_level_windows()?;
    if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
        focus_top_level_window(window)?;
        if let Some(action) = try_native_set_value_descendant(window, &stable, &text)? {
            return Ok(set_value_response_for_descendant(
                window,
                element,
                &stable,
                &path,
                &text,
                native_set_value_action_via(action),
            ));
        }
        let bounds = require_descendant_bounds(element, &stable)?;
        post_click_descendant(window, bounds)?;
        send_text_input(&text)?;
        return Ok(set_value_response_for_descendant(
            window,
            element,
            &stable,
            &path,
            &text,
            "descendant_post_message_sendinput",
        ));
    }
    let stable = require_top_level_stable_ref(stable)?;
    let window = resolve_top_level_window_ref(&windows, &stable)
        .ok_or_else(|| UiaError::no_element(stable.clone()))?;
    focus_top_level_window(window)?;
    send_text_input(&text)?;
    Ok(set_value_response_for_window(window, &stable, &text))
}

pub fn handle_focus(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let stable = read_stable_ref(&request.params, "uia_focus")?;
    let windows = enumerate_top_level_windows()?;
    if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
        focus_top_level_window(window)?;
        if try_native_focus_descendant(window, &stable)? {
            return Ok(focus_response_for_descendant(
                window,
                element,
                &stable,
                &path,
                "uia_set_focus",
            ));
        }
        let bounds = require_descendant_bounds(element, &stable)?;
        post_click_descendant(window, bounds)?;
        return Ok(focus_response_for_descendant(
            window,
            element,
            &stable,
            &path,
            "descendant_post_message",
        ));
    }
    let stable = require_top_level_stable_ref(stable)?;
    let window = resolve_top_level_window_ref(&windows, &stable)
        .ok_or_else(|| UiaError::no_element(stable.clone()))?;
    focus_top_level_window(window)?;
    Ok(focus_response_for_window(window, &stable))
}

pub fn handle_launch_app(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let app = read_app_name(&request.params, "launch_app")?;
    let args = read_args(&request.params);
    let debug_port = read_debug_port(&request.params);
    let plan = launch_plan_for_app(&app, &args, debug_port);
    run_launch_plan(&plan)?;
    Ok(serde_json::json!({
        "launched": true,
        "via": "start_process",
        "app": app,
    }))
}

fn read_stable_ref(params: &serde_json::Value, action: &str) -> Result<String, UiaError> {
    params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.starts_with("desktop-uia:"))
        .map(str::to_string)
        .ok_or_else(|| {
            UiaError::invalid_input(format!(
                "{action} requires a desktop-uia stable top-level window ref"
            ))
        })
}

fn require_top_level_stable_ref(stable: String) -> Result<String, UiaError> {
    if stable
        .split_once(':')
        .and_then(|(_, tail)| tail.split_once(':'))
        .map_or(false, |(_, path)| path.contains('/'))
    {
        return Err(UiaError::not_invokable(stable));
    }
    Ok(stable)
}

fn read_app_name(params: &serde_json::Value, action: &str) -> Result<String, UiaError> {
    params
        .get("app")
        .or_else(|| params.get("name"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| UiaError::invalid_input(format!("{action} requires app or name")))
}

fn read_args(params: &serde_json::Value) -> Vec<String> {
    params
        .get("args")
        .and_then(serde_json::Value::as_array)
        .map(|args| {
            args.iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn read_debug_port(params: &serde_json::Value) -> Option<u16> {
    params
        .get("debugPort")
        .or_else(|| params.get("debug_port"))
        .and_then(serde_json::Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
}

fn read_text_value(params: &serde_json::Value) -> Result<String, UiaError> {
    params
        .get("text")
        .or_else(|| params.get("value"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| UiaError::invalid_input("uia_set_value requires text or value"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchPlan {
    program: &'static str,
    args: Vec<String>,
}

fn launch_plan_for_app(app: &str, args: &[String], debug_port: Option<u16>) -> LaunchPlan {
    let launch_args: Vec<String> = args
        .iter()
        .cloned()
        .chain(debug_port.map(|port| format!("--remote-debugging-port={port}")))
        .collect();
    let mut plan_args = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-Command".into(),
        "Start-Process -FilePath $args[0] -ArgumentList $args[1]".into(),
        app.into(),
        launch_args.join(" "),
    ];
    if launch_args.is_empty() {
        plan_args[3] = "Start-Process -FilePath $args[0]".into();
        plan_args.truncate(5);
    }
    LaunchPlan {
        program: "powershell.exe",
        args: plan_args,
    }
}

fn run_launch_plan(plan: &LaunchPlan) -> Result<(), UiaError> {
    let status = Command::new(plan.program)
        .args(&plan.args)
        .status()
        .map_err(|err| UiaError::unavailable(format!("failed to run app launcher: {err}")))?;
    if status.success() {
        return Ok(());
    }
    Err(UiaError::unavailable(format!(
        "app launcher {} exited with status {status}",
        plan.program
    )))
}

fn focus_response_for_window(window: &WindowRecord, stable: &str) -> serde_json::Value {
    serde_json::json!({
        "focused": true,
        "via": "set_foreground_window",
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
    })
}

fn invoke_response_for_window(window: &WindowRecord, stable: &str) -> serde_json::Value {
    serde_json::json!({
        "invoked": true,
        "via": "top_level_window",
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
    })
}

fn invoke_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    via: &str,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "invoked": true,
        "via": via,
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
        "target": target,
    })
}

fn set_value_response_for_window(
    window: &WindowRecord,
    stable: &str,
    text: &str,
) -> serde_json::Value {
    serde_json::json!({
        "set": true,
        "via": "top_level_window_sendinput",
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
        "chars": text.chars().count(),
    })
}

fn set_value_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    text: &str,
    via: &str,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "set": true,
        "via": via,
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "chars": text.chars().count(),
    })
}

fn focus_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    via: &str,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "focused": true,
        "via": via,
        "stable": stable,
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
        "target": target,
    })
}

fn require_descendant_bounds<'a>(
    element: &'a ElementRecord,
    stable: &str,
) -> Result<&'a ElementBounds, UiaError> {
    element
        .bounds
        .as_ref()
        .ok_or_else(|| UiaError::not_invokable(stable.to_string()))
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

fn bounds_node(bounds: &ElementBounds) -> serde_json::Value {
    serde_json::json!({
        "x": bounds.x,
        "y": bounds.y,
        "width": bounds.width,
        "height": bounds.height,
    })
}

#[cfg(target_os = "windows")]
fn try_native_invoke_descendant(
    window: &WindowRecord,
    stable: &str,
) -> Result<Option<NativeInvokeAction>, UiaError> {
    let element = match resolve_live_descendant_element(window, stable) {
        Ok(element) => element,
        Err(_) => return Ok(None),
    };
    for action in native_invoke_actions() {
        if try_windows_native_invoke_action(&element, action) {
            return Ok(Some(action));
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
fn try_native_invoke_descendant(
    _window: &WindowRecord,
    _stable: &str,
) -> Result<Option<NativeInvokeAction>, UiaError> {
    Ok(None)
}

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeInvokeAction {
    Invoke,
    Toggle,
    SelectionItem,
}

#[cfg(any(target_os = "windows", test))]
fn native_invoke_actions() -> Vec<NativeInvokeAction> {
    vec![
        NativeInvokeAction::Invoke,
        NativeInvokeAction::Toggle,
        NativeInvokeAction::SelectionItem,
    ]
}

fn native_invoke_action_via(action: NativeInvokeAction) -> &'static str {
    match action {
        NativeInvokeAction::Invoke => "uia_invoke_pattern",
        NativeInvokeAction::Toggle => "uia_toggle_pattern",
        NativeInvokeAction::SelectionItem => "uia_selection_item_pattern",
    }
}

#[cfg(target_os = "windows")]
fn try_windows_native_invoke_action(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    action: NativeInvokeAction,
) -> bool {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern, IUIAutomationTogglePattern,
        UIA_InvokePatternId, UIA_SelectionItemPatternId, UIA_TogglePatternId,
    };

    match action {
        NativeInvokeAction::Invoke => {
            let pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)
            };
            pattern
                .map(|pattern| unsafe { pattern.Invoke() }.is_ok())
                .unwrap_or(false)
        }
        NativeInvokeAction::Toggle => {
            let pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            };
            pattern
                .map(|pattern| unsafe { pattern.Toggle() }.is_ok())
                .unwrap_or(false)
        }
        NativeInvokeAction::SelectionItem => {
            let pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(
                    UIA_SelectionItemPatternId,
                )
            };
            pattern
                .map(|pattern| unsafe { pattern.Select() }.is_ok())
                .unwrap_or(false)
        }
    }
}

#[cfg(target_os = "windows")]
fn try_native_set_value_descendant(
    window: &WindowRecord,
    stable: &str,
    text: &str,
) -> Result<Option<NativeSetValueAction>, UiaError> {
    let element = match resolve_live_descendant_element(window, stable) {
        Ok(element) => element,
        Err(_) => return Ok(None),
    };
    for action in native_set_value_actions_for_text(text) {
        if try_windows_native_set_value_action(&element, action, text) {
            return Ok(Some(action));
        }
    }
    Ok(None)
}

#[cfg(not(target_os = "windows"))]
fn try_native_set_value_descendant(
    _window: &WindowRecord,
    _stable: &str,
    _text: &str,
) -> Result<Option<NativeSetValueAction>, UiaError> {
    Ok(None)
}

#[cfg_attr(not(any(target_os = "windows", test)), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeSetValueAction {
    Value,
    RangeValue,
}

#[cfg(any(target_os = "windows", test))]
fn native_set_value_actions_for_text(text: &str) -> Vec<NativeSetValueAction> {
    let mut actions = vec![NativeSetValueAction::Value];
    if text.trim().parse::<f64>().is_ok() {
        actions.push(NativeSetValueAction::RangeValue);
    }
    actions
}

fn native_set_value_action_via(action: NativeSetValueAction) -> &'static str {
    match action {
        NativeSetValueAction::Value => "uia_value_pattern",
        NativeSetValueAction::RangeValue => "uia_range_value_pattern",
    }
}

#[cfg(target_os = "windows")]
fn try_windows_native_set_value_action(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    action: NativeSetValueAction,
    text: &str,
) -> bool {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationRangeValuePattern, IUIAutomationValuePattern, UIA_RangeValuePatternId,
        UIA_ValuePatternId,
    };

    match action {
        NativeSetValueAction::Value => {
            let pattern = unsafe {
                element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            };
            let value = windows::core::BSTR::from(text);
            pattern
                .map(|pattern| unsafe { pattern.SetValue(&value) }.is_ok())
                .unwrap_or(false)
        }
        NativeSetValueAction::RangeValue => {
            let Ok(value) = text.trim().parse::<f64>() else {
                return false;
            };
            let pattern = unsafe {
                element
                    .GetCurrentPatternAs::<IUIAutomationRangeValuePattern>(UIA_RangeValuePatternId)
            };
            pattern
                .map(|pattern| unsafe { pattern.SetValue(value) }.is_ok())
                .unwrap_or(false)
        }
    }
}

#[cfg(target_os = "windows")]
fn try_native_focus_descendant(window: &WindowRecord, stable: &str) -> Result<bool, UiaError> {
    let element = match resolve_live_descendant_element(window, stable) {
        Ok(element) => element,
        Err(_) => return Ok(false),
    };
    Ok(unsafe { element.SetFocus() }.is_ok())
}

#[cfg(not(target_os = "windows"))]
fn try_native_focus_descendant(_window: &WindowRecord, _stable: &str) -> Result<bool, UiaError> {
    Ok(false)
}

#[cfg(target_os = "windows")]
pub(crate) fn focus_top_level_window(window: &WindowRecord) -> HandlerResult {
    let hwnd = parse_hwnd(&window.hwnd)?;
    let ok = unsafe { win32::set_foreground_window(hwnd) };
    if ok != 0 {
        return Ok(serde_json::json!({ "focused": true }));
    }

    Err(UiaError::permission(format!(
        "SetForegroundWindow failed for {}: {}",
        window.hwnd,
        std::io::Error::last_os_error()
    )))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn focus_top_level_window(_window: &WindowRecord) -> HandlerResult {
    Err(crate::errors::backend_unavailable())
}

#[cfg(target_os = "windows")]
fn post_click_descendant(window: &WindowRecord, bounds: &ElementBounds) -> HandlerResult {
    let hwnd = parse_hwnd(&window.hwnd)?;
    let point = client_point_for_bounds(hwnd, bounds)?;
    let lparam = make_lparam(point.x, point.y);
    let down =
        unsafe { win32::post_message(hwnd, win32::WM_LBUTTONDOWN, win32::MK_LBUTTON, lparam) };
    let up = unsafe { win32::post_message(hwnd, win32::WM_LBUTTONUP, 0, lparam) };
    if down != 0 && up != 0 {
        return Ok(serde_json::json!({ "clicked": true }));
    }
    Err(UiaError::permission(format!(
        "PostMessage click failed for {}: {}",
        window.hwnd,
        std::io::Error::last_os_error()
    )))
}

#[cfg(not(target_os = "windows"))]
fn post_click_descendant(_window: &WindowRecord, _bounds: &ElementBounds) -> HandlerResult {
    Err(crate::errors::backend_unavailable())
}

#[cfg(target_os = "windows")]
fn parse_hwnd(value: &str) -> Result<isize, UiaError> {
    let raw = value.strip_prefix("0x").unwrap_or(value);
    isize::from_str_radix(raw, 16)
        .map_err(|_| UiaError::invalid_input(format!("invalid window handle {value}")))
}

#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClientPoint {
    x: i32,
    y: i32,
}

#[cfg(target_os = "windows")]
fn client_point_for_bounds(hwnd: isize, bounds: &ElementBounds) -> Result<ClientPoint, UiaError> {
    let mut rect = win32::Rect::default();
    let ok = unsafe { win32::get_window_rect(hwnd, &mut rect) };
    if ok == 0 {
        return Err(UiaError::permission(format!(
            "GetWindowRect failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(ClientPoint {
        x: bounds.x + (bounds.width as i32 / 2) - rect.left,
        y: bounds.y + (bounds.height as i32 / 2) - rect.top,
    })
}

#[cfg(target_os = "windows")]
fn make_lparam(x: i32, y: i32) -> isize {
    let x = (x as u16) as u32;
    let y = (y as u16) as u32;
    ((y << 16) | x) as isize
}

#[cfg(target_os = "windows")]
mod win32 {
    pub const WM_LBUTTONDOWN: u32 = 0x0201;
    pub const WM_LBUTTONUP: u32 = 0x0202;
    pub const MK_LBUTTON: isize = 0x0001;

    #[derive(Default)]
    #[repr(C)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[link(name = "user32")]
    extern "system" {
        #[link_name = "SetForegroundWindow"]
        pub fn set_foreground_window(hwnd: isize) -> i32;
        #[link_name = "GetWindowRect"]
        pub fn get_window_rect(hwnd: isize, rect: *mut Rect) -> i32;
        #[link_name = "PostMessageW"]
        pub fn post_message(hwnd: isize, msg: u32, wparam: isize, lparam: isize) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::IntoSidecarResponse;
    use crate::tree::{ElementBounds, ElementRecord, WindowRecord};

    #[test]
    fn focus_response_includes_top_level_window_target_metadata() {
        let response = focus_response_for_window(
            &WindowRecord {
                hwnd: "0x2a".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]",
        );

        assert_eq!(
            response,
            serde_json::json!({
                "focused": true,
                "via": "set_foreground_window",
                "stable": "desktop-uia:pid-42:Window[0]",
                "hwnd": "0x2a",
                "pid": 42,
                "title": "Calculator",
            }),
        );
    }

    #[test]
    fn invoke_response_marks_top_level_window_activation() {
        let response = invoke_response_for_window(
            &WindowRecord {
                hwnd: "0x2a".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]",
        );

        assert_eq!(
            response,
            serde_json::json!({
                "invoked": true,
                "via": "top_level_window",
                "stable": "desktop-uia:pid-42:Window[0]",
                "hwnd": "0x2a",
                "pid": 42,
                "title": "Calculator",
            }),
        );
    }

    #[test]
    fn invoke_response_includes_descendant_target_metadata() {
        let response = invoke_response_for_descendant(
            &WindowRecord {
                hwnd: "0x2a".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![],
            },
            &ElementRecord {
                role: "Button".into(),
                name: "Seven".into(),
                value: None,
                bounds: Some(ElementBounds {
                    x: 20,
                    y: 30,
                    width: 40,
                    height: 50,
                }),
                states: vec!["enabled".into()],
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]/Button[1]",
            "Window[0]/Button[1]",
            "post_message",
        );

        assert_eq!(
            response,
            serde_json::json!({
                "invoked": true,
                "via": "post_message",
                "stable": "desktop-uia:pid-42:Window[0]/Button[1]",
                "hwnd": "0x2a",
                "pid": 42,
                "title": "Calculator",
                "target": {
                    "role": "Button",
                    "name": "Seven",
                    "path": "Window[0]/Button[1]",
                    "bounds": {
                        "x": 20,
                        "y": 30,
                        "width": 40,
                        "height": 50,
                    },
                },
            }),
        );
    }

    #[test]
    fn native_invoke_actions_try_invoke_toggle_then_selection_item() {
        assert_eq!(
            native_invoke_actions(),
            vec![
                NativeInvokeAction::Invoke,
                NativeInvokeAction::Toggle,
                NativeInvokeAction::SelectionItem,
            ],
        );
    }

    #[test]
    fn invoke_response_can_report_native_toggle_and_selection_item_patterns() {
        let window = WindowRecord {
            hwnd: "0x2a".into(),
            pid: 42,
            title: "Settings".into(),
            children: vec![],
        };
        let element = ElementRecord {
            role: "CheckBox".into(),
            name: "Enable Sync".into(),
            value: None,
            bounds: None,
            states: vec!["enabled".into()],
            children: vec![],
        };

        let toggle = invoke_response_for_descendant(
            &window,
            &element,
            "desktop-uia:pid-42:Window[0]/CheckBox[0]",
            "Window[0]/CheckBox[0]",
            native_invoke_action_via(NativeInvokeAction::Toggle),
        );
        let selection = invoke_response_for_descendant(
            &window,
            &element,
            "desktop-uia:pid-42:Window[0]/CheckBox[0]",
            "Window[0]/CheckBox[0]",
            native_invoke_action_via(NativeInvokeAction::SelectionItem),
        );

        assert_eq!(toggle["via"], "uia_toggle_pattern");
        assert_eq!(selection["via"], "uia_selection_item_pattern");
    }

    #[test]
    fn descendant_refs_are_rejected_when_no_action_bounds_exist() {
        let error = require_descendant_bounds(
            &ElementRecord {
                role: "Button".into(),
                name: "Seven".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]/Button[1]",
        )
        .expect_err("descendant action needs target bounds");

        let response = Err::<serde_json::Value, _>(error).into_response(1, "uia_invoke".into());
        let error = response.error.expect("error envelope");
        assert_eq!(error.minimum_capability, "desktop-uia.not_invokable");
        assert_eq!(
            error.r#ref.as_deref(),
            Some("desktop-uia:pid-42:Window[0]/Button[1]"),
        );
    }

    #[test]
    fn set_value_response_can_report_native_value_pattern() {
        let response = set_value_response_for_descendant(
            &WindowRecord {
                hwnd: "0x2a".into(),
                pid: 42,
                title: "Notepad".into(),
                children: vec![],
            },
            &ElementRecord {
                role: "Edit".into(),
                name: "Document".into(),
                value: Some("old".into()),
                bounds: None,
                states: vec!["enabled".into(), "focusable".into()],
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]/Edit[0]",
            "Window[0]/Edit[0]",
            "hello",
            "uia_value_pattern",
        );

        assert_eq!(response["via"], "uia_value_pattern");
        assert_eq!(response["target"]["value"], "old");
        assert_eq!(response["chars"], 5);
    }

    #[test]
    fn native_set_value_actions_include_range_value_for_numeric_text() {
        assert_eq!(
            native_set_value_actions_for_text("42.5"),
            vec![
                NativeSetValueAction::Value,
                NativeSetValueAction::RangeValue
            ],
        );
        assert_eq!(
            native_set_value_actions_for_text("hello"),
            vec![NativeSetValueAction::Value],
        );
    }

    #[test]
    fn set_value_response_can_report_native_range_value_pattern() {
        let response = set_value_response_for_descendant(
            &WindowRecord {
                hwnd: "0x2a".into(),
                pid: 42,
                title: "Volume Mixer".into(),
                children: vec![],
            },
            &ElementRecord {
                role: "Slider".into(),
                name: "Output Volume".into(),
                value: Some("25".into()),
                bounds: None,
                states: vec!["enabled".into(), "focusable".into()],
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]/Slider[0]",
            "Window[0]/Slider[0]",
            "50",
            native_set_value_action_via(NativeSetValueAction::RangeValue),
        );

        assert_eq!(response["via"], "uia_range_value_pattern");
        assert_eq!(response["chars"], 2);
    }

    #[test]
    fn focus_response_can_report_native_set_focus() {
        let response = focus_response_for_descendant(
            &WindowRecord {
                hwnd: "0x2a".into(),
                pid: 42,
                title: "Notepad".into(),
                children: vec![],
            },
            &ElementRecord {
                role: "Edit".into(),
                name: "Document".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into(), "focusable".into()],
                children: vec![],
            },
            "desktop-uia:pid-42:Window[0]/Edit[0]",
            "Window[0]/Edit[0]",
            "uia_set_focus",
        );

        assert_eq!(response["via"], "uia_set_focus");
    }

    #[test]
    fn launch_plan_uses_powershell_start_process() {
        let plan = launch_plan_for_app("notepad", &["--safe-mode".into()], None);

        assert_eq!(plan.program, "powershell.exe");
        assert_eq!(
            plan.args,
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Process -FilePath $args[0] -ArgumentList $args[1]",
                "notepad",
                "--safe-mode",
            ],
        );
    }

    #[test]
    fn launch_plan_appends_debug_port_argument() {
        let plan = launch_plan_for_app("Code.exe", &[], Some(9230));

        assert_eq!(plan.program, "powershell.exe");
        assert_eq!(
            plan.args,
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Process -FilePath $args[0] -ArgumentList $args[1]",
                "Code.exe",
                "--remote-debugging-port=9230",
            ],
        );
    }
}
