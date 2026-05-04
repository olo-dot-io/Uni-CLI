use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use unicli_shared::SidecarRequest;

use crate::errors::{backend_unavailable, AtspiError, HandlerResult};
#[cfg(target_os = "linux")]
use crate::invoke::resolve_live_descendant_accessible;
use crate::tree::{
    enumerate_top_level_windows, resolve_descendant_element_ref, resolve_top_level_window_ref,
    ElementRecord, State, WindowRecord,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DisplayServer {
    Wayland,
    X11,
    Headless,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandPlan {
    program: String,
    args: Vec<String>,
}

pub fn handle_press(request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }

    let combo = read_combo(&request.params)?;
    let plan = press_command_for(display_server_from_env(), &combo, command_exists)?;
    run_command(&plan)?;
    Ok(serde_json::json!({
        "pressed": true,
        "combo": combo,
        "backend": plan.program
    }))
}

pub(crate) fn handle_type_text(request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }

    let text = read_text(&request.params)?;
    let plan = text_command_for(display_server_from_env(), &text, command_exists)?;
    run_command(&plan)?;
    Ok(serde_json::json!({
        "typed": true,
        "backend": plan.program,
        "chars": text.chars().count()
    }))
}

pub(crate) fn click_screen_point(x: i32, y: i32) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }

    let plan = click_command_for(display_server_from_env(), x, y, command_exists)?;
    run_command(&plan)?;
    Ok(serde_json::json!({
        "clicked": true,
        "backend": plan.program,
        "x": x,
        "y": y,
    }))
}

pub fn handle_scroll(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }

    let stable = read_optional_stable_ref(&request.params)?;
    if let Some(stable) = stable {
        let windows = enumerate_top_level_windows()?;
        let direction = read_direction(&request.params);
        let amount = read_amount(&request.params);
        if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
            if let Some(scroll) = try_native_scroll_descendant(window, &stable, &direction, amount)?
            {
                return Ok(scroll_response_for_native_descendant(
                    window, element, &stable, &path, &direction, amount, scroll,
                ));
            }
            crate::invoke::focus_top_level_window(window)?;
            let scrolled = scroll_with_params(&request.params)?;
            return Ok(scroll_response_for_descendant(
                window, element, &stable, &path, scrolled,
            ));
        }
        let window = resolve_top_level_window_ref(&windows, &stable)
            .ok_or_else(|| AtspiError::no_element(stable.clone()))?;
        crate::invoke::focus_top_level_window(window)?;
        let scrolled = scroll_with_params(&request.params)?;
        return Ok(scroll_response_for_window(window, &stable, scrolled));
    }

    scroll_with_params(&request.params)
}

fn scroll_with_params(params: &Value) -> HandlerResult {
    let direction = read_direction(params);
    let amount = read_amount(params);
    let plan = scroll_command_for(
        display_server_from_env(),
        &direction,
        amount,
        command_exists,
    )?;
    run_command(&plan)?;
    Ok(serde_json::json!({
        "scrolled": true,
        "direction": direction,
        "amount": amount,
        "backend": plan.program
    }))
}

fn read_optional_stable_ref(params: &Value) -> Result<Option<String>, AtspiError> {
    let Some(value) = params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(Value::as_str)
    else {
        return Ok(None);
    };
    if value.starts_with("desktop-atspi:") {
        return Ok(Some(value.to_string()));
    }
    Err(AtspiError::invalid_input(
        "atspi_scroll requires a desktop-atspi stable top-level window ref when ref is provided",
    ))
}

fn scroll_response_for_window(
    window: &WindowRecord,
    stable: &str,
    scroll: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "scrolled": true,
        "via": "top_level_window_scroll_helper",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "scroll": scroll,
    })
}

fn scroll_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    scroll: serde_json::Value,
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
        "via": "descendant_scroll_helper",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "scroll": scroll,
    })
}

fn scroll_response_for_native_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    direction: &str,
    amount: u32,
    scroll: serde_json::Value,
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
        "via": "atspi_component_scroll_to",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "direction": direction,
        "amount": amount,
        "scroll": scroll,
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

fn read_combo(params: &Value) -> Result<String, AtspiError> {
    params
        .get("combo")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|combo| !combo.is_empty())
        .map(String::from)
        .ok_or_else(|| AtspiError::unavailable("atspi_press requires a non-empty combo"))
}

fn read_text(params: &Value) -> Result<String, AtspiError> {
    params
        .get("text")
        .or_else(|| params.get("value"))
        .and_then(Value::as_str)
        .map(String::from)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| AtspiError::unavailable("atspi_set_value requires non-empty text"))
}

fn read_direction(params: &Value) -> String {
    params
        .get("direction")
        .and_then(Value::as_str)
        .unwrap_or("down")
        .to_ascii_lowercase()
}

fn read_amount(params: &Value) -> u32 {
    params
        .get("amount")
        .and_then(Value::as_u64)
        .and_then(|amount| u32::try_from(amount).ok())
        .filter(|amount| *amount > 0)
        .unwrap_or(300)
}

fn display_server_from_env() -> DisplayServer {
    display_server_from_iter(env::vars())
}

#[cfg(test)]
fn display_server_from_pairs<I>(pairs: I) -> DisplayServer
where
    I: IntoIterator<Item = (&'static str, &'static str)>,
{
    display_server_from_iter(pairs)
}

fn display_server_from_iter<K, V, I>(pairs: I) -> DisplayServer
where
    K: AsRef<str>,
    V: AsRef<str>,
    I: IntoIterator<Item = (K, V)>,
{
    let mut has_x11 = false;
    for (key, value) in pairs {
        let key = key.as_ref();
        let value = value.as_ref();
        if value.is_empty() {
            continue;
        }
        if key == "WAYLAND_DISPLAY" {
            return DisplayServer::Wayland;
        }
        if key == "DISPLAY" {
            has_x11 = true;
        }
    }
    if has_x11 {
        DisplayServer::X11
    } else {
        DisplayServer::Headless
    }
}

fn press_command_for(
    server: DisplayServer,
    combo: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    match server {
        DisplayServer::X11 => x11_press_command(combo, exists),
        DisplayServer::Wayland => wayland_press_command(combo, exists),
        DisplayServer::Headless => Err(AtspiError::unavailable(
            "no WAYLAND_DISPLAY or DISPLAY environment is available for input dispatch",
        )),
    }
}

fn text_command_for(
    server: DisplayServer,
    text: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    match server {
        DisplayServer::X11 => x11_text_command(text, exists),
        DisplayServer::Wayland => wayland_text_command(text, exists),
        DisplayServer::Headless => Err(AtspiError::unavailable(
            "no WAYLAND_DISPLAY or DISPLAY environment is available for text dispatch",
        )),
    }
}

fn scroll_command_for(
    server: DisplayServer,
    direction: &str,
    amount: u32,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    match server {
        DisplayServer::X11 => x11_scroll_command(direction, amount, exists),
        DisplayServer::Wayland => wayland_scroll_command(direction, amount, exists),
        DisplayServer::Headless => Err(AtspiError::unavailable(
            "no WAYLAND_DISPLAY or DISPLAY environment is available for scroll dispatch",
        )),
    }
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeComponentScrollType {
    Top,
    Bottom,
    Left,
    Right,
}

#[cfg(any(target_os = "linux", test))]
fn native_component_scroll_type_for_direction(
    direction: &str,
) -> Result<NativeComponentScrollType, AtspiError> {
    match direction {
        "up" => Ok(NativeComponentScrollType::Top),
        "down" => Ok(NativeComponentScrollType::Bottom),
        "left" => Ok(NativeComponentScrollType::Left),
        "right" => Ok(NativeComponentScrollType::Right),
        other => Err(AtspiError::unavailable(format!(
            "unsupported scroll direction {other}; expected up, down, left, or right"
        ))),
    }
}

#[cfg(target_os = "linux")]
fn try_native_scroll_descendant(
    window: &WindowRecord,
    stable: &str,
    direction: &str,
    _amount: u32,
) -> Result<Option<serde_json::Value>, AtspiError> {
    let scroll_type = native_component_scroll_type_for_direction(direction)?;
    let result = futures_lite::future::block_on(async {
        let connection = atspi::AccessibilityConnection::new().await?;
        let element = resolve_live_descendant_accessible(&connection, window, stable).await?;
        let proxies = atspi::proxy::proxy_ext::ProxyExt::proxies(&element).await?;
        let component = proxies.component().await?;
        let scrolled = component.scroll_to(atspi_scroll_type(scroll_type)).await?;
        Ok::<bool, atspi::AtspiError>(scrolled)
    });

    match result {
        Ok(true) => Ok(Some(serde_json::json!({
            "scrolled": true,
            "type": native_component_scroll_type_name(scroll_type),
        }))),
        Ok(false) | Err(_) => Ok(None),
    }
}

#[cfg(not(target_os = "linux"))]
fn try_native_scroll_descendant(
    _window: &WindowRecord,
    _stable: &str,
    _direction: &str,
    _amount: u32,
) -> Result<Option<serde_json::Value>, AtspiError> {
    Ok(None)
}

#[cfg(target_os = "linux")]
fn atspi_scroll_type(scroll_type: NativeComponentScrollType) -> atspi::ScrollType {
    match scroll_type {
        NativeComponentScrollType::Top => atspi::ScrollType::TopEdge,
        NativeComponentScrollType::Bottom => atspi::ScrollType::BottomEdge,
        NativeComponentScrollType::Left => atspi::ScrollType::LeftEdge,
        NativeComponentScrollType::Right => atspi::ScrollType::RightEdge,
    }
}

#[cfg(any(target_os = "linux", test))]
fn native_component_scroll_type_name(scroll_type: NativeComponentScrollType) -> &'static str {
    match scroll_type {
        NativeComponentScrollType::Top => "TopEdge",
        NativeComponentScrollType::Bottom => "BottomEdge",
        NativeComponentScrollType::Left => "LeftEdge",
        NativeComponentScrollType::Right => "RightEdge",
    }
}

fn click_command_for(
    server: DisplayServer,
    x: i32,
    y: i32,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    match server {
        DisplayServer::X11 => x11_click_command(x, y, exists),
        DisplayServer::Wayland => wayland_click_command(x, y, exists),
        DisplayServer::Headless => Err(AtspiError::unavailable(
            "no WAYLAND_DISPLAY or DISPLAY environment is available for click dispatch",
        )),
    }
}

fn x11_press_command(
    combo: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if !exists("xdotool") {
        return Err(AtspiError::x11_input_missing(
            "xdotool is required for AT-SPI X11 key dispatch",
        ));
    }
    Ok(CommandPlan {
        program: "xdotool".into(),
        args: vec!["key".into(), combo.into()],
    })
}

fn x11_text_command(text: &str, exists: impl Fn(&str) -> bool) -> Result<CommandPlan, AtspiError> {
    if !exists("xdotool") {
        return Err(AtspiError::x11_input_missing(
            "xdotool is required for AT-SPI X11 text dispatch",
        ));
    }
    Ok(CommandPlan {
        program: "xdotool".into(),
        args: vec!["type".into(), "--clearmodifiers".into(), text.into()],
    })
}

fn x11_scroll_command(
    direction: &str,
    amount: u32,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if !exists("xdotool") {
        return Err(AtspiError::x11_input_missing(
            "xdotool is required for AT-SPI X11 scroll dispatch",
        ));
    }
    Ok(CommandPlan {
        program: "xdotool".into(),
        args: vec![
            "click".into(),
            "--repeat".into(),
            wheel_steps(amount).to_string(),
            wheel_button(direction)?.into(),
        ],
    })
}

fn x11_click_command(
    x: i32,
    y: i32,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if !exists("xdotool") {
        return Err(AtspiError::x11_input_missing(
            "xdotool is required for AT-SPI X11 click dispatch",
        ));
    }
    Ok(CommandPlan {
        program: "xdotool".into(),
        args: vec![
            "mousemove".into(),
            "--sync".into(),
            x.to_string(),
            y.to_string(),
            "click".into(),
            "1".into(),
        ],
    })
}

fn wayland_press_command(
    combo: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if is_printable_key(combo) && exists("wtype") {
        return Ok(CommandPlan {
            program: "wtype".into(),
            args: vec![combo.into()],
        });
    }
    if exists("ydotool") {
        if let Some(args) = ydotool_key_args(combo) {
            return Ok(CommandPlan {
                program: "ydotool".into(),
                args,
            });
        }
    }
    Err(AtspiError::wayland_input_missing(
        "wtype is required for printable Wayland key dispatch; ydotool is required for supported modifier combos",
    ))
}

fn wayland_text_command(
    text: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if !exists("wtype") {
        return Err(AtspiError::wayland_input_missing(
            "wtype is required for AT-SPI Wayland text dispatch",
        ));
    }
    Ok(CommandPlan {
        program: "wtype".into(),
        args: vec![text.into()],
    })
}

fn wayland_scroll_command(
    direction: &str,
    amount: u32,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if !exists("ydotool") {
        return Err(AtspiError::wayland_input_missing(
            "ydotool is required for AT-SPI Wayland scroll dispatch",
        ));
    }
    let button = wheel_button(direction)?;
    let mut args = Vec::with_capacity(1 + wheel_steps(amount) as usize);
    args.push("click".into());
    for _ in 0..wheel_steps(amount) {
        args.push(button.into());
    }
    Ok(CommandPlan {
        program: "ydotool".into(),
        args,
    })
}

fn wayland_click_command(
    x: i32,
    y: i32,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if !exists("ydotool") {
        return Err(AtspiError::wayland_input_missing(
            "ydotool is required for AT-SPI Wayland click dispatch",
        ));
    }
    Ok(CommandPlan {
        program: "ydotool".into(),
        args: vec![
            "mousemove".into(),
            "--absolute".into(),
            x.to_string(),
            y.to_string(),
            "click".into(),
            "0xC0".into(),
        ],
    })
}

fn wheel_steps(amount: u32) -> u32 {
    amount.div_ceil(120).max(1)
}

fn wheel_button(direction: &str) -> Result<&'static str, AtspiError> {
    match direction {
        "up" => Ok("4"),
        "down" => Ok("5"),
        "left" => Ok("6"),
        "right" => Ok("7"),
        other => Err(AtspiError::unavailable(format!(
            "unsupported scroll direction {other}; expected up, down, left, or right"
        ))),
    }
}

fn is_printable_key(combo: &str) -> bool {
    let mut chars = combo.chars();
    matches!((chars.next(), chars.next()), (Some(ch), None) if !ch.is_control())
}

fn ydotool_key_args(combo: &str) -> Option<Vec<String>> {
    let mut modifier_codes = Vec::new();
    let mut key_code = None;

    for raw_part in combo.split('+') {
        let part = raw_part.trim().to_ascii_lowercase();
        let key = part.as_str();
        let code = key_code_for(key)?;
        if is_modifier(key) {
            modifier_codes.push(code);
        } else if key_code.replace(code).is_some() {
            return None;
        }
    }

    let key_code = key_code?;
    let mut args = Vec::with_capacity(1 + (modifier_codes.len() * 2) + 2);
    args.push("key".into());
    for code in &modifier_codes {
        args.push(format!("{code}:1"));
    }
    args.push(format!("{key_code}:1"));
    args.push(format!("{key_code}:0"));
    for code in modifier_codes.iter().rev() {
        args.push(format!("{code}:0"));
    }
    Some(args)
}

fn is_modifier(key: &str) -> bool {
    matches!(
        key,
        "ctrl"
            | "control"
            | "shift"
            | "alt"
            | "option"
            | "cmd"
            | "command"
            | "super"
            | "meta"
            | "win"
            | "windows"
    )
}

fn key_code_for(key: &str) -> Option<u16> {
    Some(match key {
        "ctrl" | "control" => 29,
        "shift" => 42,
        "alt" | "option" => 56,
        "cmd" | "command" | "super" | "meta" | "win" | "windows" => 125,
        "esc" | "escape" => 1,
        "1" => 2,
        "2" => 3,
        "3" => 4,
        "4" => 5,
        "5" => 6,
        "6" => 7,
        "7" => 8,
        "8" => 9,
        "9" => 10,
        "0" => 11,
        "backspace" => 14,
        "tab" => 15,
        "q" => 16,
        "w" => 17,
        "e" => 18,
        "r" => 19,
        "t" => 20,
        "y" => 21,
        "u" => 22,
        "i" => 23,
        "o" => 24,
        "p" => 25,
        "enter" | "return" => 28,
        "a" => 30,
        "s" => 31,
        "d" => 32,
        "f" => 33,
        "g" => 34,
        "h" => 35,
        "j" => 36,
        "k" => 37,
        "l" => 38,
        "z" => 44,
        "x" => 45,
        "c" => 46,
        "v" => 47,
        "b" => 48,
        "n" => 49,
        "m" => 50,
        "space" => 57,
        "delete" => 111,
        _ => return None,
    })
}

fn command_exists(program: &str) -> bool {
    let Some(paths) = env::var_os("PATH") else {
        return false;
    };
    env::split_paths(&paths).any(|path| is_executable(path.join(program)))
}

fn is_executable(path: PathBuf) -> bool {
    fs::metadata(path)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

fn run_command(plan: &CommandPlan) -> Result<(), AtspiError> {
    let status = Command::new(&plan.program)
        .args(&plan.args)
        .status()
        .map_err(|err| {
            AtspiError::unavailable(format!("failed to start {}: {err}", plan.program))
        })?;
    if status.success() {
        Ok(())
    } else {
        Err(AtspiError::unavailable(format!(
            "{} exited with status {status}",
            plan.program
        )))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::errors::IntoSidecarResponse;

    #[test]
    fn display_server_prefers_wayland_over_x11() {
        let server =
            display_server_from_pairs([("WAYLAND_DISPLAY", "wayland-0"), ("DISPLAY", ":1")]);

        assert_eq!(server, DisplayServer::Wayland);
    }

    #[test]
    fn display_server_detects_x11_when_wayland_is_absent() {
        let server = display_server_from_pairs([("DISPLAY", ":1")]);

        assert_eq!(server, DisplayServer::X11);
    }

    #[test]
    fn display_server_is_headless_without_display_environment() {
        let server = display_server_from_pairs([]);

        assert_eq!(server, DisplayServer::Headless);
    }

    #[test]
    fn x11_press_uses_xdotool_key() {
        let plan = press_command_for(DisplayServer::X11, "ctrl+s", |program| program == "xdotool")
            .expect("xdotool plan");

        assert_eq!(plan.program, "xdotool");
        assert_eq!(plan.args, vec!["key", "ctrl+s"]);
    }

    #[test]
    fn wayland_printable_press_uses_wtype() {
        let plan = press_command_for(DisplayServer::Wayland, "a", |program| program == "wtype")
            .expect("wtype plan");

        assert_eq!(plan.program, "wtype");
        assert_eq!(plan.args, vec!["a"]);
    }

    #[test]
    fn wayland_modifier_press_uses_ydotool_scancodes() {
        let plan = press_command_for(DisplayServer::Wayland, "ctrl+shift+p", |program| {
            program == "ydotool"
        })
        .expect("ydotool plan");

        assert_eq!(plan.program, "ydotool");
        assert_eq!(
            plan.args,
            vec!["key", "29:1", "42:1", "25:1", "25:0", "42:0", "29:0"]
        );
    }

    #[test]
    fn wayland_modifier_press_requires_ydotool() {
        let error = press_command_for(DisplayServer::Wayland, "ctrl+s", |program| {
            program == "wtype"
        })
        .expect_err("modifier combo without ydotool should fail");
        let response = Err::<Value, _>(error).into_response(5, "atspi_press".into());
        let envelope = response.error.expect("error envelope");

        assert_eq!(envelope.minimum_capability, "desktop-atspi.wayland-input");
    }

    #[test]
    fn x11_text_uses_xdotool_type() {
        let plan = text_command_for(DisplayServer::X11, "hello", |program| program == "xdotool")
            .expect("xdotool type plan");

        assert_eq!(plan.program, "xdotool");
        assert_eq!(plan.args, vec!["type", "--clearmodifiers", "hello"]);
    }

    #[test]
    fn wayland_text_uses_wtype() {
        let plan = text_command_for(DisplayServer::Wayland, "hello", |program| {
            program == "wtype"
        })
        .expect("wtype text plan");

        assert_eq!(plan.program, "wtype");
        assert_eq!(plan.args, vec!["hello"]);
    }

    #[test]
    fn missing_wayland_text_helper_returns_semantic_error() {
        let error = text_command_for(DisplayServer::Wayland, "hello", |_| false)
            .expect_err("missing wtype should return an error");
        let response = Err::<Value, _>(error).into_response(6, "atspi_set_value".into());
        let envelope = response.error.expect("error envelope");

        assert_eq!(envelope.minimum_capability, "desktop-atspi.wayland-input");
    }

    #[test]
    fn x11_scroll_down_uses_xdotool_wheel_button() {
        let plan = scroll_command_for(DisplayServer::X11, "down", 300, |program| {
            program == "xdotool"
        })
        .expect("xdotool scroll plan");

        assert_eq!(plan.program, "xdotool");
        assert_eq!(plan.args, vec!["click", "--repeat", "3", "5"]);
    }

    #[test]
    fn x11_scroll_up_uses_xdotool_wheel_button() {
        let plan = scroll_command_for(DisplayServer::X11, "up", 120, |program| {
            program == "xdotool"
        })
        .expect("xdotool scroll plan");

        assert_eq!(plan.program, "xdotool");
        assert_eq!(plan.args, vec!["click", "--repeat", "1", "4"]);
    }

    #[test]
    fn wayland_scroll_down_uses_ydotool_wheel_button() {
        let plan = scroll_command_for(DisplayServer::Wayland, "down", 240, |program| {
            program == "ydotool"
        })
        .expect("ydotool scroll plan");

        assert_eq!(plan.program, "ydotool");
        assert_eq!(plan.args, vec!["click", "5", "5"]);
    }

    #[test]
    fn scroll_response_includes_target_window_metadata() {
        let response = scroll_response_for_window(
            &crate::tree::WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Terminal Settings".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                children: vec![],
            },
            "desktop-atspi:pid-1234:Window[1]",
            serde_json::json!({
                "scrolled": true,
                "direction": "down",
                "amount": 240,
                "backend": "ydotool",
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "scrolled": true,
                "via": "top_level_window_scroll_helper",
                "stable": "desktop-atspi:pid-1234:Window[1]",
                "id": "0x03a00008",
                "pid": 1234,
                "title": "Terminal Settings",
                "scroll": {
                    "scrolled": true,
                    "direction": "down",
                    "amount": 240,
                    "backend": "ydotool",
                },
            }),
        );
    }

    #[test]
    fn native_component_scroll_type_maps_direction_to_edge() {
        assert_eq!(
            native_component_scroll_type_for_direction("down").expect("down type"),
            NativeComponentScrollType::Bottom,
        );
        assert_eq!(
            native_component_scroll_type_for_direction("left").expect("left type"),
            NativeComponentScrollType::Left,
        );
        assert_eq!(
            native_component_scroll_type_name(NativeComponentScrollType::Bottom),
            "BottomEdge",
        );
    }

    #[test]
    fn scroll_response_can_report_native_descendant_component_scroll() {
        let response = scroll_response_for_native_descendant(
            &crate::tree::WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Terminal Settings".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                children: vec![],
            },
            &crate::tree::ElementRecord {
                role: "scroll_pane".into(),
                name: "Output".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
            "desktop-atspi:pid-1234:Window[1]/scroll_pane[0]",
            "Window[1]/scroll_pane[0]",
            "down",
            300,
            serde_json::json!({
                "scrolled": true,
                "type": "BottomEdge",
            }),
        );

        assert_eq!(response["scrolled"], true);
        assert_eq!(response["via"], "atspi_component_scroll_to");
        assert_eq!(response["target"]["role"], "scroll_pane");
        assert_eq!(response["scroll"]["type"], "BottomEdge");
    }

    #[test]
    fn missing_x11_scroll_helper_returns_semantic_error() {
        let error = scroll_command_for(DisplayServer::X11, "down", 300, |_| false)
            .expect_err("missing xdotool should return an error");
        let response = Err::<Value, _>(error).into_response(7, "atspi_scroll".into());
        let envelope = response.error.expect("error envelope");

        assert_eq!(envelope.minimum_capability, "desktop-atspi.x11-input");
    }

    #[test]
    fn missing_x11_helper_returns_semantic_error() {
        let error = press_command_for(DisplayServer::X11, "ctrl+s", |_| false)
            .expect_err("missing helper should return an error");
        let response = Err::<Value, _>(error).into_response(3, "atspi_press".into());
        let envelope = response.error.expect("error envelope");

        assert_eq!(envelope.minimum_capability, "desktop-atspi.x11-input");
    }

    #[test]
    fn missing_wayland_helper_returns_semantic_error() {
        let error = press_command_for(DisplayServer::Wayland, "a", |_| false)
            .expect_err("missing helper should return an error");
        let response = Err::<Value, _>(error).into_response(4, "atspi_press".into());
        let envelope = response.error.expect("error envelope");

        assert_eq!(envelope.minimum_capability, "desktop-atspi.wayland-input");
    }
}
