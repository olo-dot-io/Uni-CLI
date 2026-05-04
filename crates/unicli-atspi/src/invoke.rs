use std::process::Command;

use unicli_shared::SidecarRequest;

use crate::errors::{backend_unavailable, AtspiError, HandlerResult};
use crate::tree::{
    enumerate_top_level_windows, resolve_descendant_element_ref, resolve_top_level_window_ref,
    ElementBounds, ElementRecord, State, WindowRecord,
};

pub fn handle_invoke(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let stable = read_stable_ref(&request.params, "atspi_invoke")?;
    let windows = enumerate_top_level_windows()?;
    if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
        if let Some(action) = try_native_invoke_descendant(window, &stable)? {
            return Ok(invoke_response_for_native_descendant(
                window, element, &stable, &path, action,
            ));
        }
        let bounds = require_descendant_bounds(element, &stable)?;
        focus_top_level_window(window)?;
        let clicked = click_descendant(bounds)?;
        return Ok(invoke_response_for_descendant(
            window, element, &stable, &path, clicked,
        ));
    }
    let stable = require_top_level_stable_ref(stable)?;
    let window = resolve_top_level_window_ref(&windows, &stable)
        .ok_or_else(|| AtspiError::no_element(stable.clone()))?;
    focus_top_level_window(window)?;
    Ok(invoke_response_for_window(window, &stable))
}

pub fn handle_set_value(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let Some(stable) = read_optional_stable_ref(&request.params)? else {
        return crate::input::handle_type_text(request);
    };
    let windows = enumerate_top_level_windows()?;
    if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
        if let Some((via, value)) = try_native_set_value_descendant(window, &stable, request)? {
            return Ok(set_value_response_for_native_descendant(
                window, element, &stable, &path, via, value,
            ));
        }
        let bounds = require_descendant_bounds(element, &stable)?;
        focus_top_level_window(window)?;
        let clicked = click_descendant(bounds)?;
        let typed = crate::input::handle_type_text(request)?;
        return Ok(set_value_response_for_descendant(
            window,
            element,
            &stable,
            &path,
            "descendant_click_text_helper",
            clicked,
            typed,
        ));
    }
    let stable = require_top_level_stable_ref(stable)?;
    let window = resolve_top_level_window_ref(&windows, &stable)
        .ok_or_else(|| AtspiError::no_element(stable.clone()))?;
    focus_top_level_window(window)?;
    let typed = crate::input::handle_type_text(request)?;
    Ok(set_value_response_for_window(window, &stable, typed))
}

pub fn handle_focus(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let stable = read_stable_ref(&request.params, "atspi_focus")?;
    let windows = enumerate_top_level_windows()?;
    if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
        if let Some(focus) = try_native_focus_descendant(window, &stable)? {
            return Ok(focus_response_for_native_descendant(
                window, element, &stable, &path, focus,
            ));
        }
        let bounds = require_descendant_bounds(element, &stable)?;
        focus_top_level_window(window)?;
        let clicked = click_descendant(bounds)?;
        return Ok(focus_response_for_descendant(
            window, element, &stable, &path, clicked,
        ));
    }
    let stable = require_top_level_stable_ref(stable)?;
    let window = resolve_top_level_window_ref(&windows, &stable)
        .ok_or_else(|| AtspiError::no_element(stable.clone()))?;
    let focus = focus_top_level_window(window)?;
    Ok(focus_response_for_window(window, &stable, focus))
}

pub fn handle_launch_app(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    let app = read_app_name(&request.params, "launch_app")?;
    let args = read_args(&request.params);
    let debug_port = read_debug_port(&request.params);
    let plan = launch_plan_for_app(&app, &args, debug_port);
    run_launch_plan(&plan)?;
    Ok(serde_json::json!({
        "launched": true,
        "via": "gtk_launch",
        "app": app,
    }))
}

fn read_stable_ref(params: &serde_json::Value, action: &str) -> Result<String, AtspiError> {
    params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(serde_json::Value::as_str)
        .filter(|value| value.starts_with("desktop-atspi:"))
        .map(str::to_string)
        .ok_or_else(|| {
            AtspiError::invalid_input(format!(
                "{action} requires a desktop-atspi stable top-level window ref"
            ))
        })
}

fn require_top_level_stable_ref(stable: String) -> Result<String, AtspiError> {
    if stable
        .split_once(':')
        .and_then(|(_, tail)| tail.split_once(':'))
        .map_or(false, |(_, path)| path.contains('/'))
    {
        return Err(AtspiError::not_invokable(stable));
    }
    Ok(stable)
}

fn read_app_name(params: &serde_json::Value, action: &str) -> Result<String, AtspiError> {
    params
        .get("app")
        .or_else(|| params.get("name"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AtspiError::invalid_input(format!("{action} requires app or name")))
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

fn read_optional_stable_ref(params: &serde_json::Value) -> Result<Option<String>, AtspiError> {
    let Some(value) = params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(None);
    };
    if value.starts_with("desktop-atspi:") {
        return Ok(Some(value.to_string()));
    }
    Err(AtspiError::invalid_input(
        "atspi_set_value requires a desktop-atspi stable top-level window ref when ref is provided",
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LaunchPlan {
    program: &'static str,
    args: Vec<String>,
}

fn launch_plan_for_app(app: &str, args: &[String], debug_port: Option<u16>) -> LaunchPlan {
    LaunchPlan {
        program: "gtk-launch",
        args: std::iter::once(app.to_string())
            .chain(args.iter().cloned())
            .chain(debug_port.map(|port| format!("--remote-debugging-port={port}")))
            .collect(),
    }
}

fn run_launch_plan(plan: &LaunchPlan) -> Result<(), AtspiError> {
    let status = Command::new(plan.program)
        .args(&plan.args)
        .status()
        .map_err(|err| AtspiError::unavailable(format!("failed to run app launcher: {err}")))?;
    if status.success() {
        return Ok(());
    }
    Err(AtspiError::unavailable(format!(
        "app launcher {} exited with status {status}",
        plan.program
    )))
}

fn focus_response_for_window(
    window: &WindowRecord,
    stable: &str,
    focus: serde_json::Value,
) -> serde_json::Value {
    let via = focus
        .get("via")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("wmctrl_activate");
    let mut response = serde_json::json!({
        "focused": true,
        "via": via,
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
    });
    if via != "wmctrl_activate" {
        response["focus"] = focus;
    }
    response
}

fn invoke_response_for_window(window: &WindowRecord, stable: &str) -> serde_json::Value {
    serde_json::json!({
        "invoked": true,
        "via": "top_level_window",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
    })
}

fn invoke_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    click: serde_json::Value,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "invoked": true,
        "via": "descendant_click_helper",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "click": click,
    })
}

fn invoke_response_for_native_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    action: serde_json::Value,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "invoked": true,
        "via": "atspi_action_proxy",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "action": action,
    })
}

fn set_value_response_for_window(
    window: &WindowRecord,
    stable: &str,
    typed: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "set": true,
        "via": "top_level_window_text_helper",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "typed": typed,
    })
}

fn set_value_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    via: &str,
    click: serde_json::Value,
    typed: serde_json::Value,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "set": true,
        "via": via,
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "click": click,
        "typed": typed,
    })
}

fn set_value_response_for_native_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    via: &str,
    value: serde_json::Value,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "set": true,
        "via": via,
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "value": value,
    })
}

fn focus_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    click: serde_json::Value,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "focused": true,
        "via": "descendant_click_helper",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "click": click,
    })
}

fn focus_response_for_native_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    focus: serde_json::Value,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "focused": true,
        "via": "atspi_component_proxy",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "focus": focus,
    })
}

fn require_descendant_bounds<'a>(
    element: &'a ElementRecord,
    stable: &str,
) -> Result<&'a ElementBounds, AtspiError> {
    element
        .bounds
        .as_ref()
        .ok_or_else(|| AtspiError::not_invokable(stable.to_string()))
}

fn click_descendant(bounds: &ElementBounds) -> HandlerResult {
    crate::input::click_screen_point(
        bounds.x + (bounds.width as i32 / 2),
        bounds.y + (bounds.height as i32 / 2),
    )
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

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq)]
enum NativeSetValueRequest {
    Numeric(f64),
    EditableText(String),
}

#[cfg(any(target_os = "linux", test))]
fn native_set_value_request(params: &serde_json::Value) -> Option<NativeSetValueRequest> {
    if let Some(value) = params.get("value") {
        return numeric_param_value(value)
            .map(NativeSetValueRequest::Numeric)
            .or_else(|| {
                value
                    .as_str()
                    .map(str::to_string)
                    .map(NativeSetValueRequest::EditableText)
            });
    }
    let text = params.get("text")?;
    numeric_param_value(text)
        .map(NativeSetValueRequest::Numeric)
        .or_else(|| {
            text.as_str()
                .map(str::to_string)
                .map(NativeSetValueRequest::EditableText)
        })
}

#[cfg(any(target_os = "linux", test))]
fn numeric_param_value(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_str()?.parse().ok())
}

#[cfg(any(target_os = "linux", test))]
fn native_set_value_via(request: &NativeSetValueRequest) -> &'static str {
    match request {
        NativeSetValueRequest::Numeric(_) => "atspi_value_proxy",
        NativeSetValueRequest::EditableText(_) => "atspi_editable_text_proxy",
    }
}

#[cfg(target_os = "linux")]
fn try_native_invoke_descendant(
    window: &WindowRecord,
    stable: &str,
) -> Result<Option<serde_json::Value>, AtspiError> {
    let result = futures_lite::future::block_on(async {
        let connection = atspi::AccessibilityConnection::new().await?;
        let element = resolve_live_descendant_accessible(&connection, window, stable).await?;
        let proxies = atspi::proxy::proxy_ext::ProxyExt::proxies(&element).await?;
        let action = proxies.action().await?;
        let invoked = action.do_action(0).await?;
        Ok::<bool, atspi::AtspiError>(invoked)
    });

    match result {
        Ok(true) => Ok(Some(serde_json::json!({
            "action": true,
            "index": 0,
        }))),
        Ok(false) | Err(_) => Ok(None),
    }
}

#[cfg(not(target_os = "linux"))]
fn try_native_invoke_descendant(
    _window: &WindowRecord,
    _stable: &str,
) -> Result<Option<serde_json::Value>, AtspiError> {
    Ok(None)
}

#[cfg(target_os = "linux")]
fn try_native_set_value_descendant(
    window: &WindowRecord,
    stable: &str,
    request: &SidecarRequest,
) -> Result<Option<(&'static str, serde_json::Value)>, AtspiError> {
    let Some(value) = native_set_value_request(&request.params) else {
        return Ok(None);
    };
    let result = futures_lite::future::block_on(async {
        let connection = atspi::AccessibilityConnection::new().await?;
        let element = resolve_live_descendant_accessible(&connection, window, stable).await?;
        let proxies = atspi::proxy::proxy_ext::ProxyExt::proxies(&element).await?;
        match &value {
            NativeSetValueRequest::Numeric(value) => {
                let value_proxy = proxies.value().await?;
                value_proxy.set_current_value(*value).await?;
            }
            NativeSetValueRequest::EditableText(text) => {
                let editable_text = proxies.editable_text().await?;
                editable_text.set_text_contents(text).await?;
            }
        }
        Ok::<NativeSetValueRequest, atspi::AtspiError>(value)
    });

    match result {
        Ok(NativeSetValueRequest::Numeric(value)) => Ok(Some((
            native_set_value_via(&NativeSetValueRequest::Numeric(value)),
            serde_json::json!({
                "set": true,
                "value": value,
            }),
        ))),
        Ok(NativeSetValueRequest::EditableText(text)) => Ok(Some((
            native_set_value_via(&NativeSetValueRequest::EditableText(text.clone())),
            serde_json::json!({
                "set": true,
                "text": text,
            }),
        ))),
        Err(_) => Ok(None),
    }
}

#[cfg(not(target_os = "linux"))]
fn try_native_set_value_descendant(
    _window: &WindowRecord,
    _stable: &str,
    _request: &SidecarRequest,
) -> Result<Option<(&'static str, serde_json::Value)>, AtspiError> {
    Ok(None)
}

#[cfg(target_os = "linux")]
fn try_native_focus_descendant(
    window: &WindowRecord,
    stable: &str,
) -> Result<Option<serde_json::Value>, AtspiError> {
    let result = futures_lite::future::block_on(async {
        let connection = atspi::AccessibilityConnection::new().await?;
        let element = resolve_live_descendant_accessible(&connection, window, stable).await?;
        let proxies = atspi::proxy::proxy_ext::ProxyExt::proxies(&element).await?;
        let component = proxies.component().await?;
        let focused = component.grab_focus().await?;
        Ok::<bool, atspi::AtspiError>(focused)
    });

    match result {
        Ok(true) => Ok(Some(serde_json::json!({ "focused": true }))),
        Ok(false) | Err(_) => Ok(None),
    }
}

#[cfg(not(target_os = "linux"))]
fn try_native_focus_descendant(
    _window: &WindowRecord,
    _stable: &str,
) -> Result<Option<serde_json::Value>, AtspiError> {
    Ok(None)
}

#[cfg(target_os = "linux")]
pub(crate) async fn resolve_live_descendant_accessible<'a>(
    connection: &'a atspi::AccessibilityConnection,
    window: &WindowRecord,
    stable: &str,
) -> Result<atspi::proxy::accessible::AccessibleProxy<'a>, atspi::AtspiError> {
    use atspi::proxy::accessible::ObjectRefExt;
    use std::collections::VecDeque;

    let mut segments = descendant_segments(stable)
        .ok_or_else(|| atspi::AtspiError::InterfaceNotAvailable("invalid stable ref"))?;
    let _window_segment = segments
        .first()
        .ok_or_else(|| atspi::AtspiError::InterfaceNotAvailable("missing window segment"))?;
    let descendant_segments = segments.split_off(1);
    let root = connection.root_accessible_on_registry().await?;
    let mut candidates: VecDeque<_> = root.get_children().await?.into();
    let conn = connection.connection();

    while let Some(candidate_ref) = candidates.pop_front() {
        let candidate = candidate_ref.into_accessible_proxy(conn).await?;
        if accessible_matches_window(&candidate, window).await {
            return follow_descendant_segments(conn, candidate, descendant_segments).await;
        }
        for child_ref in candidate.get_children().await.unwrap_or_default() {
            candidates.push_back(child_ref);
        }
    }

    Err(atspi::AtspiError::InterfaceNotAvailable(
        "window accessible",
    ))
}

#[cfg(target_os = "linux")]
async fn accessible_matches_window(
    accessible: &atspi::proxy::accessible::AccessibleProxy<'_>,
    window: &WindowRecord,
) -> bool {
    let role = accessible
        .get_role()
        .await
        .map(|role| normalize_atspi_role(role.name()))
        .unwrap_or_default();
    let name = accessible.name().await.unwrap_or_default();
    matches!(role.as_str(), "frame" | "window" | "dialog")
        && (name == window.title || (!name.is_empty() && window.title.contains(&name)))
}

#[cfg(target_os = "linux")]
async fn follow_descendant_segments<'a>(
    conn: &'a zbus::Connection,
    mut current: atspi::proxy::accessible::AccessibleProxy<'a>,
    segments: Vec<(String, usize)>,
) -> Result<atspi::proxy::accessible::AccessibleProxy<'a>, atspi::AtspiError> {
    use atspi::proxy::accessible::ObjectRefExt;

    for (role, target_index) in segments {
        let mut role_index = 0usize;
        let mut matched = None;
        for child_ref in current.get_children().await? {
            let child = child_ref.into_accessible_proxy(conn).await?;
            let child_role = child
                .get_role()
                .await
                .map(|role| normalize_atspi_role(role.name()))
                .unwrap_or_default();
            if child_role == role.as_str() {
                if role_index == target_index {
                    matched = Some(child);
                    break;
                }
                role_index += 1;
            }
        }
        current = matched.ok_or(atspi::AtspiError::InterfaceNotAvailable(
            "descendant segment",
        ))?;
    }

    Ok(current)
}

#[cfg(target_os = "linux")]
fn descendant_segments(stable: &str) -> Option<Vec<(String, usize)>> {
    let (_, path) = stable.strip_prefix("desktop-atspi:")?.split_once(':')?;
    Some(
        path.split('/')
            .filter_map(parse_indexed_path_segment)
            .map(|(role, index)| (role.to_string(), index))
            .collect(),
    )
}

#[cfg(target_os = "linux")]
fn parse_indexed_path_segment(segment: &str) -> Option<(&str, usize)> {
    let (role, raw_index) = segment.split_once('[')?;
    let index = raw_index.strip_suffix(']')?.parse::<usize>().ok()?;
    Some((role, index))
}

#[cfg(target_os = "linux")]
fn normalize_atspi_role(role: &str) -> String {
    role.to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split('_')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

pub(crate) fn focus_top_level_window(window: &WindowRecord) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    if let Some(focus) = try_native_focus_top_level_window(window)? {
        return Ok(focus);
    }
    let Some(plan) = activation_plan_for_window(window) else {
        return Err(AtspiError::not_invokable(window_stable_hint(window)));
    };
    let status = Command::new(plan.program)
        .args(&plan.args)
        .status()
        .map_err(|err| AtspiError::unavailable(format!("failed to run wmctrl: {err}")))?;
    if status.success() {
        return Ok(serde_json::json!({
            "focused": true,
            "via": "wmctrl_activate",
        }));
    }

    Err(AtspiError::unavailable(format!(
        "wmctrl -ia {} exited with status {status}",
        window.id
    )))
}

struct ActivationPlan {
    program: &'static str,
    args: Vec<String>,
}

fn activation_plan_for_window(window: &WindowRecord) -> Option<ActivationPlan> {
    if is_synthetic_atspi_window(window) {
        return None;
    }
    Some(ActivationPlan {
        program: "wmctrl",
        args: vec!["-ia".into(), window.id.clone()],
    })
}

fn is_synthetic_atspi_window(window: &WindowRecord) -> bool {
    window.id.starts_with("atspi-root-") || (window.desktop == "atspi" && window.host == "atspi")
}

fn window_stable_hint(window: &WindowRecord) -> String {
    format!("desktop-atspi:pid-{}:Window[0]", window.pid)
}

#[cfg(target_os = "linux")]
fn try_native_focus_top_level_window(
    window: &WindowRecord,
) -> Result<Option<serde_json::Value>, AtspiError> {
    if !is_synthetic_atspi_window(window) {
        return Ok(None);
    }
    let result = futures_lite::future::block_on(async {
        let connection = atspi::AccessibilityConnection::new().await?;
        let root = connection.root_accessible_on_registry().await?;
        let conn = connection.connection();
        for child_ref in root.get_children().await? {
            let child =
                atspi::proxy::accessible::ObjectRefExt::into_accessible_proxy(child_ref, conn)
                    .await?;
            if accessible_matches_window(&child, window).await {
                let proxies = atspi::proxy::proxy_ext::ProxyExt::proxies(&child).await?;
                let component = proxies.component().await?;
                let focused = component.grab_focus().await?;
                return Ok::<bool, atspi::AtspiError>(focused);
            }
        }
        Ok::<bool, atspi::AtspiError>(false)
    });

    match result {
        Ok(true) => Ok(Some(serde_json::json!({
            "focused": true,
            "via": "atspi_component_proxy",
        }))),
        Ok(false) | Err(_) => Ok(None),
    }
}

#[cfg(not(target_os = "linux"))]
fn try_native_focus_top_level_window(
    _window: &WindowRecord,
) -> Result<Option<serde_json::Value>, AtspiError> {
    Ok(None)
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
                "focused": true,
                "via": "wmctrl_activate",
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "focused": true,
                "via": "wmctrl_activate",
                "stable": "desktop-atspi:pid-1234:Window[1]",
                "id": "0x03a00008",
                "pid": 1234,
                "title": "Terminal Settings",
            }),
        );
    }

    #[test]
    fn focus_response_reports_native_top_level_focus_via() {
        let response = focus_response_for_window(
            &WindowRecord {
                id: "atspi-root-0".into(),
                pid: u32::MAX,
                title: "Preferences".into(),
                desktop: "atspi".into(),
                host: "atspi".into(),
                bounds: None,
                children: vec![],
            },
            "desktop-atspi:pid-4294967295:Window[0]",
            serde_json::json!({
                "focused": true,
                "via": "atspi_component_proxy",
            }),
        );

        assert_eq!(response["via"], "atspi_component_proxy");
        assert_eq!(response["focus"]["via"], "atspi_component_proxy");
    }

    #[test]
    fn activation_plan_uses_wmctrl_window_id() {
        let plan = activation_plan_for_window(&WindowRecord {
            id: "0x03a00008".into(),
            pid: 1234,
            title: "Terminal Settings".into(),
            desktop: "0".into(),
            host: "host".into(),
            bounds: None,
            children: vec![],
        })
        .expect("wmctrl-backed window");

        assert_eq!(plan.program, "wmctrl");
        assert_eq!(plan.args, vec!["-ia", "0x03a00008"]);
    }

    #[test]
    fn activation_plan_skips_synthetic_atspi_windows() {
        let plan = activation_plan_for_window(&WindowRecord {
            id: "atspi-root-0".into(),
            pid: u32::MAX,
            title: "Preferences".into(),
            desktop: "atspi".into(),
            host: "atspi".into(),
            bounds: None,
            children: vec![],
        });

        assert!(plan.is_none());
    }

    #[test]
    fn launch_plan_uses_gtk_launch() {
        let plan = launch_plan_for_app("org.gnome.Calculator", &["--safe-mode".into()], None);

        assert_eq!(plan.program, "gtk-launch");
        assert_eq!(plan.args, vec!["org.gnome.Calculator", "--safe-mode"]);
    }

    #[test]
    fn launch_plan_appends_debug_port_argument() {
        let plan = launch_plan_for_app("code.desktop", &[], Some(9230));

        assert_eq!(plan.program, "gtk-launch");
        assert_eq!(
            plan.args,
            vec!["code.desktop", "--remote-debugging-port=9230"],
        );
    }

    #[test]
    fn set_value_response_includes_target_window_metadata() {
        let response = set_value_response_for_window(
            &WindowRecord {
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
                "typed": true,
                "backend": "xdotool",
                "chars": 5,
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "set": true,
                "via": "top_level_window_text_helper",
                "stable": "desktop-atspi:pid-1234:Window[1]",
                "id": "0x03a00008",
                "pid": 1234,
                "title": "Terminal Settings",
                "typed": {
                    "typed": true,
                    "backend": "xdotool",
                    "chars": 5,
                },
            }),
        );
    }

    #[test]
    fn invoke_response_includes_descendant_target_metadata() {
        let response = invoke_response_for_descendant(
            &WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Calculator".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                children: vec![],
            },
            &ElementRecord {
                role: "push_button".into(),
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
            "desktop-atspi:pid-1234:Window[0]/push_button[1]",
            "Window[0]/push_button[1]",
            serde_json::json!({
                "clicked": true,
                "backend": "xdotool",
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "invoked": true,
                "via": "descendant_click_helper",
                "stable": "desktop-atspi:pid-1234:Window[0]/push_button[1]",
                "id": "0x03a00008",
                "pid": 1234,
                "title": "Calculator",
                "target": {
                    "role": "push_button",
                    "name": "Seven",
                    "path": "Window[0]/push_button[1]",
                    "bounds": {
                        "x": 20,
                        "y": 30,
                        "width": 40,
                        "height": 50,
                    },
                },
                "click": {
                    "clicked": true,
                    "backend": "xdotool",
                },
            }),
        );
    }

    #[test]
    fn descendant_refs_are_rejected_when_no_action_bounds_exist() {
        let error = require_descendant_bounds(
            &ElementRecord {
                role: "push_button".into(),
                name: "Seven".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
            "desktop-atspi:pid-1234:Window[0]/push_button[1]",
        )
        .expect_err("descendant action needs target bounds");

        let response = Err::<serde_json::Value, _>(error).into_response(1, "atspi_invoke".into());
        let error = response.error.expect("error envelope");
        assert_eq!(error.minimum_capability, "desktop-atspi.not_invokable");
        assert_eq!(
            error.r#ref.as_deref(),
            Some("desktop-atspi:pid-1234:Window[0]/push_button[1]"),
        );
    }

    #[test]
    fn set_value_request_uses_editable_text_proxy_for_non_numeric_text() {
        let request = native_set_value_request(&serde_json::json!({
            "text": "Ada Lovelace",
        }))
        .expect("text request");

        assert_eq!(
            request,
            NativeSetValueRequest::EditableText("Ada Lovelace".into()),
        );
    }

    #[test]
    fn set_value_request_uses_value_proxy_for_numeric_value() {
        let request = native_set_value_request(&serde_json::json!({
            "value": 42.5,
        }))
        .expect("numeric request");

        assert_eq!(request, NativeSetValueRequest::Numeric(42.5));
    }

    #[test]
    fn set_value_request_reports_editable_text_proxy_via() {
        assert_eq!(
            native_set_value_via(&NativeSetValueRequest::EditableText("Ada".into())),
            "atspi_editable_text_proxy",
        );
    }

    #[test]
    fn invoke_response_can_report_native_action_proxy() {
        let response = invoke_response_for_native_descendant(
            &WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Calculator".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                children: vec![],
            },
            &ElementRecord {
                role: "push_button".into(),
                name: "Seven".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
            "desktop-atspi:pid-1234:Window[0]/push_button[1]",
            "Window[0]/push_button[1]",
            serde_json::json!({
                "action": true,
                "index": 0,
            }),
        );

        assert_eq!(response["via"], "atspi_action_proxy");
        assert_eq!(response["action"]["index"], 0);
    }

    #[test]
    fn focus_response_can_report_native_component_proxy() {
        let response = focus_response_for_native_descendant(
            &WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Calculator".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                children: vec![],
            },
            &ElementRecord {
                role: "text".into(),
                name: "Display".into(),
                value: None,
                bounds: None,
                states: vec!["focusable".into()],
                children: vec![],
            },
            "desktop-atspi:pid-1234:Window[0]/text[0]",
            "Window[0]/text[0]",
            serde_json::json!({
                "focused": true,
            }),
        );

        assert_eq!(response["via"], "atspi_component_proxy");
        assert_eq!(response["focus"]["focused"], true);
    }
}
