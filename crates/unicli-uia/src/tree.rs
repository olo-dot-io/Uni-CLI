use std::collections::BTreeMap;
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::Value;
use unicli_shared::SidecarRequest;

use crate::errors::{HandlerResult, UiaError};
use crate::refs::RefTable;

#[derive(Default)]
pub struct State {
    refs: RefTable,
}

impl State {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn refs_mut(&mut self) -> &mut RefTable {
        &mut self.refs
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowRecord {
    pub(crate) hwnd: String,
    pub(crate) pid: u32,
    pub(crate) title: String,
    pub(crate) children: Vec<ElementRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ElementRecord {
    pub(crate) role: String,
    pub(crate) name: String,
    pub(crate) value: Option<String>,
    pub(crate) bounds: Option<ElementBounds>,
    pub(crate) states: Vec<String>,
    pub(crate) children: Vec<ElementRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ElementBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[cfg(any(target_os = "windows", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct UiaElementProperties {
    control_type_id: i32,
    name: Option<String>,
    value: Option<String>,
    bounds: Option<ElementBounds>,
    enabled: bool,
    focusable: bool,
    horizontally_scrollable: bool,
    vertically_scrollable: bool,
}

#[cfg(any(target_os = "windows", test))]
fn element_record_from_uia_properties(props: UiaElementProperties) -> Option<ElementRecord> {
    let role = uia_control_type_role(props.control_type_id)?.to_string();
    let name = props.name.unwrap_or_default();
    let value = props.value.filter(|value| !value.is_empty());
    if name.is_empty() && value.is_none() && props.bounds.is_none() {
        return None;
    }
    let mut states = Vec::new();
    if props.enabled {
        states.push("enabled".into());
    }
    if props.focusable {
        states.push("focusable".into());
    }
    if props.horizontally_scrollable {
        states.push("horizontally_scrollable".into());
    }
    if props.vertically_scrollable {
        states.push("vertically_scrollable".into());
    }
    Some(ElementRecord {
        role,
        name,
        value,
        bounds: props.bounds,
        states,
        children: Vec::new(),
    })
}

#[cfg(any(target_os = "windows", test))]
fn uia_control_type_role(id: i32) -> Option<&'static str> {
    Some(match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => return None,
    })
}

pub fn handle_apps(_state: &mut State, _request: &SidecarRequest) -> HandlerResult {
    let windows = enumerate_top_level_windows()?;
    Ok(apps_response_from_windows(&windows))
}

pub fn handle_windows(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let windows = enumerate_top_level_windows()?;
    Ok(windows_response_from_windows(&windows, &request.params))
}

pub fn handle_snapshot(state: &mut State, request: &SidecarRequest) -> HandlerResult {
    state.refs_mut().clear();
    let windows = enumerate_top_level_windows()?;
    Ok(snapshot_response_from_windows(&windows, &request.params))
}

pub fn handle_find(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let windows = enumerate_top_level_windows()?;
    find_response_from_windows(&windows, &request.params)
}

pub fn handle_wait(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let timeout = read_timeout(&request.params);
    let poll_interval = read_poll_interval(&request.params);
    let started = Instant::now();

    loop {
        let windows = enumerate_top_level_windows()?;
        if let Ok(response) = wait_response_from_windows(&windows, &request.params) {
            return Ok(response);
        }

        if started.elapsed() >= timeout {
            return Err(UiaError::no_element("top-level window wait"));
        }

        sleep(poll_interval.min(timeout.saturating_sub(started.elapsed())));
    }
}

pub fn handle_observe(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let windows = enumerate_top_level_windows()?;
    Ok(observe_response_from_windows(&windows, &request.params))
}

pub fn handle_assert(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    let windows = enumerate_top_level_windows()?;
    assert_response_from_windows(&windows, &request.params)
}

fn apps_response_from_windows(windows: &[WindowRecord]) -> Value {
    let mut by_pid: BTreeMap<u32, (&str, usize)> = BTreeMap::new();
    for window in windows {
        by_pid
            .entry(window.pid)
            .and_modify(|(_, count)| *count += 1)
            .or_insert((window.title.as_str(), 1));
    }

    let mut apps: Vec<Value> = by_pid
        .into_iter()
        .map(|(pid, (name, window_count))| {
            serde_json::json!({
                "name": name,
                "pid": pid,
                "windowCount": window_count,
            })
        })
        .collect();
    apps.sort_by(|left, right| {
        let left_name = left
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        let right_name = right
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase();
        left_name.cmp(&right_name)
    });

    serde_json::json!({
        "mode": "apps",
        "count": apps.len(),
        "apps": apps,
    })
}

fn windows_response_from_windows(windows: &[WindowRecord], params: &Value) -> Value {
    let windows: Vec<Value> = windows
        .iter()
        .filter(|window| window_matches_params(window, params))
        .map(|window| {
            serde_json::json!({
                "id": window.hwnd,
                "hwnd": window.hwnd,
                "name": window.title,
                "title": window.title,
                "pid": window.pid,
                "visible": true,
            })
        })
        .collect();

    serde_json::json!({
        "mode": "windows",
        "count": windows.len(),
        "windows": windows,
    })
}

fn snapshot_response_from_windows(windows: &[WindowRecord], params: &Value) -> Value {
    let children: Vec<Value> = windows
        .iter()
        .filter(|window| window_matches_params(window, params))
        .map(|window| {
            let index = pid_local_window_index(windows, window);
            window_node(window, index, false)
        })
        .collect();

    serde_json::json!({
        "role": "Desktop",
        "name": "Windows Desktop",
        "path": "Desktop[0]",
        "scope": "desktop",
        "children": children,
    })
}

fn find_response_from_windows(windows: &[WindowRecord], params: &Value) -> HandlerResult {
    let mut matches = Vec::new();
    for window in windows
        .iter()
        .filter(|window| window_matches_params(window, params))
    {
        let index = pid_local_window_index(windows, window);
        if window_node_matches_find_params(window, params) {
            matches.push(window_node(window, index, true));
        }
        collect_descendant_matches(&mut matches, window, index, params);
    }

    if params.get("first").and_then(Value::as_bool) == Some(true) {
        return matches
            .into_iter()
            .next()
            .ok_or_else(|| UiaError::no_element("top-level window query"));
    }

    Ok(serde_json::json!(matches))
}

fn wait_response_from_windows(windows: &[WindowRecord], params: &Value) -> HandlerResult {
    let (via, node) = first_matching_node(windows, params)
        .ok_or_else(|| UiaError::no_element("top-level window query"))?;

    Ok(serde_json::json!({
        "matched": true,
        "via": via,
        "node": node,
    }))
}

fn observe_response_from_windows(windows: &[WindowRecord], params: &Value) -> Value {
    let goal = params
        .get("goal")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let top_k = read_top_k(params);
    let mut candidates: Vec<Value> = Vec::new();
    for window in windows
        .iter()
        .filter(|window| window_matches_params(window, params))
    {
        if let Some((confidence, reason)) = score_window_for_goal(window, goal) {
            let index = pid_local_window_index(windows, window);
            let stable = window_stable(window, index);
            candidates.push(serde_json::json!({
                "action": "click",
                "ref": stable,
                "stable": stable,
                "role": "Window",
                "name": window.title,
                "confidence": confidence,
                "reason": reason,
            }));
        }

        let index = pid_local_window_index(windows, window);
        collect_descendant_observe_candidates(&mut candidates, window, index, goal);
    }

    candidates.sort_by(|left, right| {
        let left_confidence = left
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        let right_confidence = right
            .get("confidence")
            .and_then(Value::as_f64)
            .unwrap_or_default();
        right_confidence
            .total_cmp(&left_confidence)
            .then_with(|| candidate_name(left).cmp(&candidate_name(right)))
    });
    candidates.truncate(top_k);

    serde_json::json!({
        "goal": goal,
        "count": candidates.len(),
        "candidates": candidates,
    })
}

fn assert_response_from_windows(windows: &[WindowRecord], params: &Value) -> HandlerResult {
    if let Some(stable) = stable_param(params) {
        if !stable.starts_with("desktop-uia:") {
            return Err(UiaError::invalid_input(
                "uia_assert requires a desktop-uia stable ref when ref is provided",
            ));
        }
        let (via, node) = assert_target_ref_node(windows, stable, params)
            .ok_or_else(|| UiaError::no_element(stable.to_string()))?;

        return Ok(serde_json::json!({
            "asserted": true,
            "via": via,
            "checks": assertion_checks(params),
            "node": node,
        }));
    }

    let (via, node) = first_assertion_node(windows, params)
        .ok_or_else(|| UiaError::no_element("top-level window assertion"))?;

    Ok(serde_json::json!({
        "asserted": true,
        "via": via,
        "checks": assertion_checks(params),
        "node": node,
    }))
}

fn stable_param(params: &Value) -> Option<&str> {
    params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(Value::as_str)
}

#[allow(dead_code)] // Used by ref-backed focus/invoke handlers after top-level refs land.
pub(crate) fn resolve_top_level_window_ref<'a>(
    windows: &'a [WindowRecord],
    stable: &str,
) -> Option<&'a WindowRecord> {
    let (scope, path) = stable.strip_prefix("desktop-uia:")?.split_once(':')?;
    let pid = scope.strip_prefix("pid-")?.parse::<u32>().ok()?;
    let index = path
        .strip_prefix("Window[")?
        .strip_suffix(']')?
        .parse::<usize>()
        .ok()?;

    windows.iter().filter(|window| window.pid == pid).nth(index)
}

fn assert_target_ref_node(
    windows: &[WindowRecord],
    stable: &str,
    params: &Value,
) -> Option<(&'static str, Value)> {
    if let Some(window) = resolve_top_level_window_ref(windows, stable) {
        if window_satisfies_assertion(window, params) {
            let index = pid_local_window_index(windows, window);
            return Some((
                "top_level_window_inventory",
                window_node(window, index, true),
            ));
        }
        return None;
    }

    let (window, element, path) = resolve_descendant_element_ref(windows, stable)?;
    if element_matches_find_params(element, params) && element_state_filter_matches(element, params)
    {
        let scope = format!("pid-{}", window.pid);
        return Some((
            "native_descendant_tree",
            element_node(
                element,
                &scope,
                &window.title,
                window.pid,
                &path,
                true,
                false,
            ),
        ));
    }
    None
}

pub(crate) fn resolve_descendant_element_ref<'a>(
    windows: &'a [WindowRecord],
    stable: &str,
) -> Option<(&'a WindowRecord, &'a ElementRecord, String)> {
    let (scope, path) = stable.strip_prefix("desktop-uia:")?.split_once(':')?;
    let pid = scope.strip_prefix("pid-")?.parse::<u32>().ok()?;
    let mut segments = path.split('/');
    let (window_role, window_index) = parse_indexed_path_segment(segments.next()?)?;
    if window_role != "Window" {
        return None;
    }
    let window = windows
        .iter()
        .filter(|window| window.pid == pid)
        .nth(window_index)?;
    let mut resolved_path = format!("Window[{window_index}]");
    let mut children = window.children.as_slice();
    let mut current = None;

    for segment in segments {
        let (role, index) = parse_indexed_path_segment(segment)?;
        let element = children
            .iter()
            .filter(|element| element.role == role)
            .nth(index)?;
        resolved_path.push('/');
        resolved_path.push_str(segment);
        children = element.children.as_slice();
        current = Some(element);
    }

    current.map(|element| (window, element, resolved_path))
}

fn parse_indexed_path_segment(segment: &str) -> Option<(&str, usize)> {
    let (role, raw_index) = segment.split_once('[')?;
    let index = raw_index.strip_suffix(']')?.parse::<usize>().ok()?;
    Some((role, index))
}

#[cfg(target_os = "windows")]
pub(crate) fn resolve_live_descendant_element(
    window: &WindowRecord,
    stable: &str,
) -> Result<windows::Win32::UI::Accessibility::IUIAutomationElement, UiaError> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    let (_, path) = stable
        .strip_prefix("desktop-uia:")
        .and_then(|tail| tail.split_once(':'))
        .ok_or_else(|| UiaError::invalid_input(format!("invalid UIA stable ref {stable}")))?;
    let mut segments = path.split('/');
    let (window_role, _) = segments
        .next()
        .and_then(parse_indexed_path_segment)
        .ok_or_else(|| UiaError::invalid_input(format!("invalid UIA stable ref {stable}")))?;
    if window_role != "Window" {
        return Err(UiaError::invalid_input(format!(
            "invalid UIA stable ref {stable}"
        )));
    }

    let hwnd = parse_hwnd(&window.hwnd)?;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|err| {
                UiaError::unavailable(format!("failed to create UIAutomation: {err}"))
            })?;
        let walker = automation
            .ControlViewWalker()
            .map_err(|err| UiaError::unavailable(format!("ControlViewWalker failed: {err}")))?;
        let mut current = automation
            .ElementFromHandle(HWND(hwnd as *mut c_void))
            .map_err(|err| UiaError::unavailable(format!("ElementFromHandle failed: {err}")))?;

        for segment in segments {
            let (role, index) = parse_indexed_path_segment(segment).ok_or_else(|| {
                UiaError::invalid_input(format!("invalid UIA stable ref {stable}"))
            })?;
            current = child_element_by_role_index(&walker, &current, role, index)
                .ok_or_else(|| UiaError::no_element(stable.to_string()))?;
        }

        Ok(current)
    }
}

#[cfg(target_os = "windows")]
fn child_element_by_role_index(
    walker: &windows::Win32::UI::Accessibility::IUIAutomationTreeWalker,
    parent: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    role: &str,
    target_index: usize,
) -> Option<windows::Win32::UI::Accessibility::IUIAutomationElement> {
    let mut child = unsafe { walker.GetFirstChildElement(parent) }.ok()?;
    let mut role_index = 0usize;
    loop {
        if live_uia_element_role(&child) == Some(role) {
            if role_index == target_index {
                return Some(child);
            }
            role_index += 1;
        }
        child = match unsafe { walker.GetNextSiblingElement(&child) } {
            Ok(next) => next,
            Err(_) => break,
        };
    }
    None
}

#[cfg(target_os = "windows")]
fn live_uia_element_role(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<&'static str> {
    let control_type_id = unsafe { element.CurrentControlType().ok()? }.0;
    uia_control_type_role(control_type_id)
}

#[cfg(target_os = "windows")]
fn parse_hwnd(value: &str) -> Result<isize, UiaError> {
    let raw = value.strip_prefix("0x").unwrap_or(value);
    isize::from_str_radix(raw, 16)
        .map_err(|_| UiaError::invalid_input(format!("invalid window handle {value}")))
}

fn pid_local_window_index(windows: &[WindowRecord], target: &WindowRecord) -> usize {
    windows
        .iter()
        .filter(|window| window.pid == target.pid)
        .position(|window| window.hwnd == target.hwnd)
        .unwrap_or(0)
}

fn window_node(window: &WindowRecord, index: usize, include_stable: bool) -> Value {
    let path = format!("Window[{index}]");
    let scope = format!("pid-{}", window.pid);
    let mut node = serde_json::json!({
        "role": "Window",
        "name": window.title,
        "path": path,
        "scope": scope,
        "app": window.title,
        "pid": window.pid,
        "states": ["visible"],
        "metadata": {
            "hwnd": window.hwnd,
        },
    });

    if include_stable {
        node["stable"] = serde_json::json!(window_stable(window, index));
    }
    if !window.children.is_empty() {
        node["children"] = serde_json::json!(element_nodes(
            &window.children,
            &scope,
            &window.title,
            window.pid,
            &path,
            include_stable,
        ));
    }

    node
}

fn window_stable(window: &WindowRecord, index: usize) -> String {
    format!("desktop-uia:pid-{}:Window[{index}]", window.pid)
}

fn window_matches_params(window: &WindowRecord, params: &Value) -> bool {
    let pid_filter = params
        .get("pid")
        .and_then(Value::as_u64)
        .map(|pid| pid as u32);
    let app_filter = params
        .get("app")
        .and_then(Value::as_str)
        .map(|app| app.to_ascii_lowercase());

    pid_filter.map_or(true, |pid| window.pid == pid)
        && app_filter
            .as_ref()
            .map_or(true, |app| window.title.to_ascii_lowercase().contains(app))
}

fn window_matches_find_params(window: &WindowRecord, params: &Value) -> bool {
    window_matches_params(window, params) && window_node_matches_find_params(window, params)
}

fn window_node_matches_find_params(window: &WindowRecord, params: &Value) -> bool {
    let role_filter = params
        .get("role")
        .and_then(Value::as_str)
        .map(|role| role.to_ascii_lowercase());
    let name_filter = params
        .get("name")
        .or_else(|| params.get("title"))
        .and_then(Value::as_str)
        .map(|name| name.to_ascii_lowercase());

    role_filter
        .as_ref()
        .map_or(true, |role| role == "window" || role == "desktop-window")
        && name_filter.as_ref().map_or(true, |name| {
            window.title.to_ascii_lowercase().contains(name)
        })
        && text_matches(&window.title, None, params)
}

fn window_satisfies_assertion(window: &WindowRecord, params: &Value) -> bool {
    window_matches_find_params(window, params)
        && text_filter_matches(window, params)
        && window_state_filter_matches(params)
}

fn text_filter_matches(window: &WindowRecord, params: &Value) -> bool {
    text_matches(&window.title, None, params)
}

fn window_state_filter_matches(params: &Value) -> bool {
    params
        .get("state")
        .and_then(Value::as_str)
        .map(|state| {
            matches!(
                state.to_ascii_lowercase().as_str(),
                "visible" | "appear" | "enabled"
            )
        })
        .unwrap_or(true)
}

fn assertion_checks(params: &Value) -> Value {
    let mut checks = serde_json::Map::new();
    if let Some(text) = params.get("text").and_then(Value::as_str) {
        checks.insert("text".into(), serde_json::json!(text));
    }
    if let Some(state) = params.get("state").and_then(Value::as_str) {
        checks.insert("state".into(), serde_json::json!(state));
    }
    Value::Object(checks)
}

fn read_timeout(params: &Value) -> Duration {
    Duration::from_millis(
        read_u64_param(params, &["timeoutMs", "timeout_ms", "timeout"], 10_000).clamp(1, 60_000),
    )
}

fn read_poll_interval(params: &Value) -> Duration {
    Duration::from_millis(
        read_u64_param(
            params,
            &["pollMs", "poll_ms", "intervalMs", "interval_ms"],
            100,
        )
        .clamp(10, 1_000),
    )
}

fn read_top_k(params: &Value) -> usize {
    read_u64_param(params, &["topK", "top_k", "limit"], 5)
        .clamp(1, 50)
        .try_into()
        .unwrap_or(5)
}

fn read_u64_param(params: &Value, names: &[&str], default: u64) -> u64 {
    names
        .iter()
        .find_map(|name| params.get(*name))
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<u64>().ok()))
        })
        .unwrap_or(default)
}

fn score_window_for_goal(window: &WindowRecord, goal: &str) -> Option<(f64, &'static str)> {
    score_label_for_goal(&window.title, goal, "title", Some("Window"))
}

fn score_label_for_goal(
    label: &str,
    goal: &str,
    label_kind: &'static str,
    fallback_role: Option<&str>,
) -> Option<(f64, &'static str)> {
    let goal_tokens = tokenize(goal);
    if goal_tokens.is_empty() {
        return None;
    }

    let normalized_goal = goal_tokens.join(" ");
    if label.to_ascii_lowercase().trim() == normalized_goal {
        return Some((
            0.95,
            if label_kind == "name" {
                "exact name match"
            } else {
                "exact title match"
            },
        ));
    }

    let label_tokens = tokenize(label);
    let matched = goal_tokens
        .iter()
        .filter(|query| token_matches_any(query, &label_tokens))
        .count();
    if matched == goal_tokens.len() {
        return Some((
            0.85,
            if label_kind == "name" {
                "all goal tokens in name"
            } else {
                "all goal tokens in title"
            },
        ));
    }
    if matched > 0 {
        let confidence = 0.4 + (matched as f64 / goal_tokens.len() as f64) * 0.4;
        return Some((
            round_confidence(confidence),
            if label_kind == "name" {
                "some goal tokens in name"
            } else {
                "some goal tokens in title"
            },
        ));
    }
    if let Some(role) = fallback_role {
        if goal_tokens
            .iter()
            .any(|token| token == &role.to_ascii_lowercase())
        {
            return Some((0.1, "role match"));
        }
    }

    None
}

fn token_matches_any(query: &str, tokens: &[String]) -> bool {
    tokens.iter().any(|label| {
        if query.len() < 3 {
            label == query
        } else {
            label == query || label.contains(query) || (label.len() >= 3 && query.contains(label))
        }
    })
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn round_confidence(confidence: f64) -> f64 {
    (confidence * 1000.0).round() / 1000.0
}

fn candidate_name(candidate: &Value) -> String {
    candidate
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn element_nodes(
    elements: &[ElementRecord],
    scope: &str,
    app: &str,
    pid: u32,
    parent_path: &str,
    include_stable: bool,
) -> Vec<Value> {
    let mut role_counts: BTreeMap<&str, usize> = BTreeMap::new();
    elements
        .iter()
        .map(|element| {
            let index = role_counts.entry(element.role.as_str()).or_insert(0);
            let path = format!("{parent_path}/{}[{index}]", element.role);
            *index += 1;
            element_node(element, scope, app, pid, &path, include_stable, true)
        })
        .collect()
}

fn element_node(
    element: &ElementRecord,
    scope: &str,
    app: &str,
    pid: u32,
    path: &str,
    include_stable: bool,
    include_children: bool,
) -> Value {
    let mut node = serde_json::json!({
        "role": element.role,
        "name": element.name,
        "path": path,
        "scope": scope,
        "app": app,
        "pid": pid,
        "states": element.states,
    });

    if let Some(value) = &element.value {
        node["value"] = serde_json::json!(value);
    }
    if let Some(bounds) = &element.bounds {
        node["bounds"] = serde_json::json!({
            "x": bounds.x,
            "y": bounds.y,
            "width": bounds.width,
            "height": bounds.height,
        });
    }
    if include_stable {
        node["stable"] = serde_json::json!(format!("desktop-uia:{scope}:{path}"));
    }
    if include_children && !element.children.is_empty() {
        node["children"] = serde_json::json!(element_nodes(
            &element.children,
            scope,
            app,
            pid,
            path,
            include_stable,
        ));
    }

    node
}

fn collect_descendant_matches(
    matches: &mut Vec<Value>,
    window: &WindowRecord,
    window_index: usize,
    params: &Value,
) {
    let scope = format!("pid-{}", window.pid);
    let path = format!("Window[{window_index}]");
    collect_element_matches(
        matches,
        &window.children,
        &scope,
        &window.title,
        window.pid,
        &path,
        params,
    );
}

fn collect_descendant_observe_candidates(
    candidates: &mut Vec<Value>,
    window: &WindowRecord,
    window_index: usize,
    goal: &str,
) {
    let scope = format!("pid-{}", window.pid);
    let path = format!("Window[{window_index}]");
    collect_element_observe_candidates(candidates, &window.children, &scope, &path, goal);
}

fn collect_element_observe_candidates(
    candidates: &mut Vec<Value>,
    elements: &[ElementRecord],
    scope: &str,
    parent_path: &str,
    goal: &str,
) {
    let mut role_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for element in elements {
        let index = role_counts.entry(element.role.as_str()).or_insert(0);
        let path = format!("{parent_path}/{}[{index}]", element.role);
        *index += 1;
        if let Some((confidence, reason)) =
            score_label_for_goal(&element.name, goal, "name", Some(&element.role))
        {
            let stable = format!("desktop-uia:{scope}:{path}");
            let mut candidate = serde_json::json!({
                "action": action_for_element(element),
                "ref": stable,
                "stable": stable,
                "role": element.role,
                "name": element.name,
                "states": element.states,
                "confidence": confidence,
                "reason": reason,
            });
            if let Some(value) = &element.value {
                candidate["value"] = serde_json::json!(value);
            }
            if let Some(bounds) = &element.bounds {
                candidate["bounds"] = serde_json::json!({
                    "x": bounds.x,
                    "y": bounds.y,
                    "width": bounds.width,
                    "height": bounds.height,
                });
            }
            candidates.push(candidate);
        }
        collect_element_observe_candidates(candidates, &element.children, scope, &path, goal);
    }
}

fn action_for_element(element: &ElementRecord) -> &'static str {
    if element_is_scrollable(element) {
        "scroll"
    } else if element_is_settable(element) {
        "set_value"
    } else {
        "click"
    }
}

fn element_is_scrollable(element: &ElementRecord) -> bool {
    let role = element.role.to_ascii_lowercase();
    role.contains("scroll")
        || element.states.iter().any(|state| {
            matches!(
                state.as_str(),
                "scrollable" | "horizontally_scrollable" | "vertically_scrollable"
            )
        })
}

fn element_is_settable(element: &ElementRecord) -> bool {
    let role = element.role.to_ascii_lowercase();
    role.contains("edit")
        || role.contains("text")
        || role.contains("slider")
        || role.contains("spinner")
        || role.contains("range")
}

fn first_matching_node(windows: &[WindowRecord], params: &Value) -> Option<(&'static str, Value)> {
    for window in windows
        .iter()
        .filter(|window| window_matches_params(window, params))
    {
        let index = pid_local_window_index(windows, window);
        if window_node_matches_find_params(window, params) {
            return Some((
                "top_level_window_inventory",
                window_node(window, index, true),
            ));
        }

        let mut descendants = Vec::new();
        collect_descendant_matches(&mut descendants, window, index, params);
        if let Some(node) = descendants.into_iter().next() {
            return Some(("native_descendant_tree", node));
        }
    }

    None
}

fn first_assertion_node(windows: &[WindowRecord], params: &Value) -> Option<(&'static str, Value)> {
    for window in windows
        .iter()
        .filter(|window| window_matches_params(window, params))
    {
        let index = pid_local_window_index(windows, window);
        if window_node_matches_find_params(window, params) && window_state_filter_matches(params) {
            return Some((
                "top_level_window_inventory",
                window_node(window, index, true),
            ));
        }

        let mut descendants = Vec::new();
        collect_descendant_assertion_matches(&mut descendants, window, index, params);
        if let Some(node) = descendants.into_iter().next() {
            return Some(("native_descendant_tree", node));
        }
    }

    None
}

fn collect_element_matches(
    matches: &mut Vec<Value>,
    elements: &[ElementRecord],
    scope: &str,
    app: &str,
    pid: u32,
    parent_path: &str,
    params: &Value,
) {
    let mut role_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for element in elements {
        let index = role_counts.entry(element.role.as_str()).or_insert(0);
        let path = format!("{parent_path}/{}[{index}]", element.role);
        *index += 1;
        if element_matches_find_params(element, params) {
            matches.push(element_node(element, scope, app, pid, &path, true, false));
        }
        collect_element_matches(matches, &element.children, scope, app, pid, &path, params);
    }
}

fn collect_descendant_assertion_matches(
    matches: &mut Vec<Value>,
    window: &WindowRecord,
    window_index: usize,
    params: &Value,
) {
    let scope = format!("pid-{}", window.pid);
    let path = format!("Window[{window_index}]");
    collect_element_assertion_matches(
        matches,
        &window.children,
        &scope,
        &window.title,
        window.pid,
        &path,
        params,
    );
}

fn collect_element_assertion_matches(
    matches: &mut Vec<Value>,
    elements: &[ElementRecord],
    scope: &str,
    app: &str,
    pid: u32,
    parent_path: &str,
    params: &Value,
) {
    let mut role_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for element in elements {
        let index = role_counts.entry(element.role.as_str()).or_insert(0);
        let path = format!("{parent_path}/{}[{index}]", element.role);
        *index += 1;
        if element_matches_find_params(element, params)
            && element_state_filter_matches(element, params)
        {
            matches.push(element_node(element, scope, app, pid, &path, true, false));
        }
        collect_element_assertion_matches(
            matches,
            &element.children,
            scope,
            app,
            pid,
            &path,
            params,
        );
    }
}

fn element_matches_find_params(element: &ElementRecord, params: &Value) -> bool {
    let role_filter = params
        .get("role")
        .and_then(Value::as_str)
        .map(|role| role.to_ascii_lowercase());
    let name_filter = params
        .get("name")
        .or_else(|| params.get("title"))
        .and_then(Value::as_str)
        .map(|name| name.to_ascii_lowercase());

    role_filter
        .as_ref()
        .map_or(true, |role| element.role.to_ascii_lowercase() == *role)
        && name_filter.as_ref().map_or(true, |name| {
            element.name.to_ascii_lowercase().contains(name)
        })
        && text_matches(&element.name, element.value.as_deref(), params)
}

fn text_matches(name: &str, value: Option<&str>, params: &Value) -> bool {
    let Some(text) = params.get("text").and_then(Value::as_str) else {
        return true;
    };
    let needle = text.to_ascii_lowercase();
    value
        .map(|value| value.to_ascii_lowercase().contains(&needle))
        .unwrap_or(false)
        || name.to_ascii_lowercase().contains(&needle)
}

fn element_state_filter_matches(element: &ElementRecord, params: &Value) -> bool {
    let Some(state) = params.get("state").and_then(Value::as_str) else {
        return true;
    };
    let state = state.to_ascii_lowercase();
    if state == "appear" {
        return true;
    }
    element
        .states
        .iter()
        .any(|candidate| candidate.to_ascii_lowercase() == state)
}

#[cfg(target_os = "windows")]
pub(crate) fn enumerate_top_level_windows() -> Result<Vec<WindowRecord>, UiaError> {
    let mut windows = Vec::new();
    let ok = unsafe { win32::enum_windows(Some(enum_window), &mut windows as *mut _ as isize) };
    if ok != 0 {
        return Ok(windows);
    }

    Err(UiaError::unavailable(format!(
        "EnumWindows failed: {}",
        std::io::Error::last_os_error()
    )))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn enumerate_top_level_windows() -> Result<Vec<WindowRecord>, UiaError> {
    Err(crate::errors::backend_unavailable())
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_window(hwnd: isize, lparam: isize) -> i32 {
    let windows = &mut *(lparam as *mut Vec<WindowRecord>);
    if let Some(window) = window_record_for_hwnd(hwnd) {
        windows.push(window);
    }
    1
}

#[cfg(target_os = "windows")]
fn window_record_for_hwnd(hwnd: isize) -> Option<WindowRecord> {
    if unsafe { win32::is_window_visible(hwnd) } == 0 {
        return None;
    }

    let title_len = unsafe { win32::get_window_text_length_w(hwnd) };
    if title_len <= 0 {
        return None;
    }

    let mut buffer = vec![0u16; title_len as usize + 1];
    let copied =
        unsafe { win32::get_window_text_w(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if copied <= 0 {
        return None;
    }

    buffer.truncate(copied as usize);
    let title = String::from_utf16_lossy(&buffer).trim().to_string();
    if title.is_empty() {
        return None;
    }

    let mut pid = 0u32;
    unsafe {
        win32::get_window_thread_process_id(hwnd, &mut pid);
    }
    if pid == 0 {
        return None;
    }

    let children = descendant_records_for_hwnd(hwnd).unwrap_or_default();

    Some(WindowRecord {
        hwnd: format!("0x{:x}", hwnd as usize),
        pid,
        title,
        children,
    })
}

#[cfg(target_os = "windows")]
fn descendant_records_for_hwnd(hwnd: isize) -> Result<Vec<ElementRecord>, UiaError> {
    use std::ffi::c_void;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)
            .map_err(|err| {
                UiaError::unavailable(format!("failed to create UIAutomation: {err}"))
            })?;
        let root = automation
            .ElementFromHandle(HWND(hwnd as *mut c_void))
            .map_err(|err| UiaError::unavailable(format!("ElementFromHandle failed: {err}")))?;
        let walker = automation
            .ControlViewWalker()
            .map_err(|err| UiaError::unavailable(format!("ControlViewWalker failed: {err}")))?;
        let mut count = 0usize;
        Ok(collect_child_records(&walker, &root, 0, &mut count))
    }
}

#[cfg(target_os = "windows")]
fn collect_child_records(
    walker: &windows::Win32::UI::Accessibility::IUIAutomationTreeWalker,
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
    depth: usize,
    count: &mut usize,
) -> Vec<ElementRecord> {
    const MAX_DEPTH: usize = 6;
    const MAX_ELEMENTS: usize = 512;
    if depth >= MAX_DEPTH || *count >= MAX_ELEMENTS {
        return Vec::new();
    }

    let mut records = Vec::new();
    let Ok(mut child) = (unsafe { walker.GetFirstChildElement(element) }) else {
        return records;
    };

    loop {
        if *count >= MAX_ELEMENTS {
            break;
        }
        if let Some(mut record) = element_record_from_windows_uia(&child) {
            *count += 1;
            record.children = collect_child_records(walker, &child, depth + 1, count);
            records.push(record);
        } else {
            let grandchildren = collect_child_records(walker, &child, depth + 1, count);
            records.extend(grandchildren);
        }
        child = match unsafe { walker.GetNextSiblingElement(&child) } {
            Ok(next) => next,
            Err(_) => break,
        };
    }
    records
}

#[cfg(target_os = "windows")]
fn element_record_from_windows_uia(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<ElementRecord> {
    use windows::Win32::UI::Accessibility::UIA_ValueValuePropertyId;

    let control_type_id = unsafe { element.CurrentControlType().ok()? }.0;
    let name = unsafe { element.CurrentName() }
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty());
    let value = unsafe { element.GetCurrentPropertyValue(UIA_ValueValuePropertyId) }
        .ok()
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty());
    let enabled = unsafe { element.CurrentIsEnabled() }
        .ok()
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let focusable = unsafe { element.CurrentIsKeyboardFocusable() }
        .ok()
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let (horizontally_scrollable, vertically_scrollable) = scrollability_from_windows_uia(element);
    let bounds = unsafe { element.CurrentBoundingRectangle() }
        .ok()
        .and_then(|rect| {
            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            if width <= 0 || height <= 0 {
                return None;
            }
            Some(ElementBounds {
                x: rect.left,
                y: rect.top,
                width: width as u32,
                height: height as u32,
            })
        });

    element_record_from_uia_properties(UiaElementProperties {
        control_type_id,
        name,
        value,
        bounds,
        enabled,
        focusable,
        horizontally_scrollable,
        vertically_scrollable,
    })
}

#[cfg(target_os = "windows")]
fn scrollability_from_windows_uia(
    element: &windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> (bool, bool) {
    use windows::Win32::UI::Accessibility::{IUIAutomationScrollPattern, UIA_ScrollPatternId};

    let Ok(pattern) =
        (unsafe { element.GetCurrentPatternAs::<IUIAutomationScrollPattern>(UIA_ScrollPatternId) })
    else {
        return (false, false);
    };
    let horizontal = unsafe { pattern.CurrentHorizontallyScrollable() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let vertical = unsafe { pattern.CurrentVerticallyScrollable() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    (horizontal, vertical)
}

#[cfg(target_os = "windows")]
mod win32 {
    pub type EnumWindowsProc = unsafe extern "system" fn(isize, isize) -> i32;

    #[link(name = "user32")]
    extern "system" {
        #[link_name = "EnumWindows"]
        pub fn enum_windows(callback: Option<EnumWindowsProc>, lparam: isize) -> i32;
        #[link_name = "IsWindowVisible"]
        pub fn is_window_visible(hwnd: isize) -> i32;
        #[link_name = "GetWindowTextLengthW"]
        pub fn get_window_text_length_w(hwnd: isize) -> i32;
        #[link_name = "GetWindowTextW"]
        pub fn get_window_text_w(hwnd: isize, text: *mut u16, max_count: i32) -> i32;
        #[link_name = "GetWindowThreadProcessId"]
        pub fn get_window_thread_process_id(hwnd: isize, process_id: *mut u32) -> u32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apps_response_groups_windows_by_pid_and_sorts_by_name() {
        let response = apps_response_from_windows(&[
            WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Beta".into(),
                children: vec![],
            },
            WindowRecord {
                hwnd: "0x3".into(),
                pid: 7,
                title: "Alpha".into(),
                children: vec![],
            },
            WindowRecord {
                hwnd: "0x4".into(),
                pid: 42,
                title: "Beta Preferences".into(),
                children: vec![],
            },
        ]);

        assert_eq!(
            response,
            serde_json::json!({
                "mode": "apps",
                "count": 2,
                "apps": [
                    {
                        "name": "Alpha",
                        "pid": 7,
                        "windowCount": 1,
                    },
                    {
                        "name": "Beta",
                        "pid": 42,
                        "windowCount": 2,
                    },
                ],
            }),
        );
    }

    #[test]
    fn snapshot_response_emits_raw_ax_root_with_window_children() {
        let response = snapshot_response_from_windows(
            &[
                WindowRecord {
                    hwnd: "0x3".into(),
                    pid: 7,
                    title: "Alpha".into(),
                    children: vec![],
                },
                WindowRecord {
                    hwnd: "0x2".into(),
                    pid: 42,
                    title: "Beta".into(),
                    children: vec![],
                },
            ],
            &serde_json::json!({ "app": "bet" }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "role": "Desktop",
                "name": "Windows Desktop",
                "path": "Desktop[0]",
                "scope": "desktop",
                "children": [
                    {
                        "role": "Window",
                        "name": "Beta",
                        "path": "Window[0]",
                        "scope": "pid-42",
                        "app": "Beta",
                        "pid": 42,
                        "states": ["visible"],
                        "metadata": {
                            "hwnd": "0x2",
                        },
                    },
                ],
            }),
        );
    }

    #[test]
    fn snapshot_response_emits_descendant_bounds() {
        let response = snapshot_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![ElementRecord {
                    role: "Button".into(),
                    name: "Eight".into(),
                    value: None,
                    bounds: Some(ElementBounds {
                        x: 120,
                        y: 220,
                        width: 44,
                        height: 36,
                    }),
                    states: vec!["enabled".into()],
                    children: vec![],
                }],
            }],
            &serde_json::json!({}),
        );

        assert_eq!(
            response["children"][0]["children"][0]["bounds"],
            serde_json::json!({
                "x": 120,
                "y": 220,
                "width": 44,
                "height": 36,
            }),
        );
    }

    #[test]
    fn find_response_returns_first_matching_top_level_window() {
        let response = find_response_from_windows(
            &[
                WindowRecord {
                    hwnd: "0x3".into(),
                    pid: 7,
                    title: "Alpha".into(),
                    children: vec![],
                },
                WindowRecord {
                    hwnd: "0x2".into(),
                    pid: 42,
                    title: "Beta".into(),
                    children: vec![],
                },
            ],
            &serde_json::json!({
                "role": "window",
                "name": "bet",
                "first": true,
            }),
        )
        .expect("find response");

        assert_eq!(
            response,
            serde_json::json!({
                "role": "Window",
                "name": "Beta",
                "path": "Window[0]",
                "scope": "pid-42",
                "stable": "desktop-uia:pid-42:Window[0]",
                "app": "Beta",
                "pid": 42,
                "states": ["visible"],
                "metadata": {
                    "hwnd": "0x2",
                },
            }),
        );
    }

    #[test]
    fn find_response_returns_descendant_by_role_name_and_value() {
        let response = find_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![
                    ElementRecord {
                        role: "Button".into(),
                        name: "Eight".into(),
                        value: None,
                        bounds: None,
                        states: vec!["enabled".into()],
                        children: vec![],
                    },
                    ElementRecord {
                        role: "Edit".into(),
                        name: "Display".into(),
                        value: Some("8".into()),
                        bounds: None,
                        states: vec!["focusable".into(), "enabled".into()],
                        children: vec![],
                    },
                ],
            }],
            &serde_json::json!({
                "role": "edit",
                "text": "8",
                "first": true,
            }),
        )
        .expect("matching descendant");

        assert_eq!(
            response,
            serde_json::json!({
                "role": "Edit",
                "name": "Display",
                "value": "8",
                "path": "Window[0]/Edit[0]",
                "scope": "pid-42",
                "stable": "desktop-uia:pid-42:Window[0]/Edit[0]",
                "app": "Calculator",
                "pid": 42,
                "states": ["focusable", "enabled"],
            }),
        );
    }

    #[test]
    fn wait_response_returns_first_matching_top_level_window() {
        let response = wait_response_from_windows(
            &[
                WindowRecord {
                    hwnd: "0x3".into(),
                    pid: 7,
                    title: "Alpha".into(),
                    children: vec![],
                },
                WindowRecord {
                    hwnd: "0x2".into(),
                    pid: 42,
                    title: "Beta Preferences".into(),
                    children: vec![],
                },
            ],
            &serde_json::json!({
                "role": "window",
                "name": "preferences",
                "app": "beta",
            }),
        )
        .expect("matching window");

        assert_eq!(
            response,
            serde_json::json!({
                "matched": true,
                "via": "top_level_window_inventory",
                "node": {
                    "role": "Window",
                    "name": "Beta Preferences",
                    "path": "Window[0]",
                    "scope": "pid-42",
                    "stable": "desktop-uia:pid-42:Window[0]",
                    "app": "Beta Preferences",
                    "pid": 42,
                    "states": ["visible"],
                    "metadata": {
                        "hwnd": "0x2",
                    },
                },
            }),
        );
    }

    #[test]
    fn wait_response_returns_matching_descendant_by_value() {
        let response = wait_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![ElementRecord {
                    role: "Edit".into(),
                    name: "Display".into(),
                    value: Some("8".into()),
                    bounds: None,
                    states: vec!["focusable".into(), "enabled".into()],
                    children: vec![],
                }],
            }],
            &serde_json::json!({
                "role": "edit",
                "text": "8",
            }),
        )
        .expect("matching descendant");

        assert_eq!(
            response,
            serde_json::json!({
                "matched": true,
                "via": "native_descendant_tree",
                "node": {
                    "role": "Edit",
                    "name": "Display",
                    "value": "8",
                    "path": "Window[0]/Edit[0]",
                    "scope": "pid-42",
                    "stable": "desktop-uia:pid-42:Window[0]/Edit[0]",
                    "app": "Calculator",
                    "pid": 42,
                    "states": ["focusable", "enabled"],
                },
            }),
        );
    }

    #[test]
    fn observe_response_ranks_top_level_windows_by_goal() {
        let response = observe_response_from_windows(
            &[
                WindowRecord {
                    hwnd: "0x3".into(),
                    pid: 7,
                    title: "Alpha".into(),
                    children: vec![],
                },
                WindowRecord {
                    hwnd: "0x2".into(),
                    pid: 42,
                    title: "Beta Preferences".into(),
                    children: vec![],
                },
            ],
            &serde_json::json!({
                "goal": "beta preferences",
                "topK": 1,
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "goal": "beta preferences",
                "count": 1,
                "candidates": [
                    {
                        "action": "click",
                        "ref": "desktop-uia:pid-42:Window[0]",
                        "stable": "desktop-uia:pid-42:Window[0]",
                        "role": "Window",
                        "name": "Beta Preferences",
                        "confidence": 0.95,
                        "reason": "exact title match",
                    },
                ],
            }),
        );
    }

    #[test]
    fn observe_response_ranks_descendant_elements_by_goal() {
        let response = observe_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![
                    ElementRecord {
                        role: "Button".into(),
                        name: "Five".into(),
                        value: None,
                        bounds: None,
                        states: vec!["enabled".into()],
                        children: vec![],
                    },
                    ElementRecord {
                        role: "Button".into(),
                        name: "Eight".into(),
                        value: None,
                        bounds: None,
                        states: vec!["enabled".into()],
                        children: vec![],
                    },
                ],
            }],
            &serde_json::json!({
                "goal": "eight",
                "topK": 1,
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "goal": "eight",
                "count": 1,
                "candidates": [
                    {
                        "action": "click",
                        "ref": "desktop-uia:pid-42:Window[0]/Button[1]",
                        "stable": "desktop-uia:pid-42:Window[0]/Button[1]",
                        "role": "Button",
                        "name": "Eight",
                        "states": ["enabled"],
                        "confidence": 0.95,
                        "reason": "exact name match",
                    },
                ],
            }),
        );
    }

    #[test]
    fn observe_response_marks_scrollable_descendant_action() {
        let response = observe_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Settings".into(),
                children: vec![ElementRecord {
                    role: "Pane".into(),
                    name: "Results".into(),
                    value: None,
                    bounds: None,
                    states: vec!["enabled".into(), "vertically_scrollable".into()],
                    children: vec![],
                }],
            }],
            &serde_json::json!({
                "goal": "results",
                "topK": 1,
            }),
        );

        assert_eq!(response["candidates"][0]["action"], "scroll");
        assert_eq!(
            response["candidates"][0]["stable"],
            "desktop-uia:pid-42:Window[0]/Pane[0]",
        );
    }

    #[test]
    fn observe_response_marks_range_descendant_action_as_set_value() {
        let response = observe_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Settings".into(),
                children: vec![ElementRecord {
                    role: "Slider".into(),
                    name: "Volume".into(),
                    value: Some("35".into()),
                    bounds: None,
                    states: vec!["enabled".into()],
                    children: vec![],
                }],
            }],
            &serde_json::json!({
                "goal": "volume",
                "topK": 1,
            }),
        );

        assert_eq!(response["candidates"][0]["action"], "set_value");
        assert_eq!(
            response["candidates"][0]["stable"],
            "desktop-uia:pid-42:Window[0]/Slider[0]",
        );
    }

    #[test]
    fn observe_response_preserves_descendant_value_states_and_bounds() {
        let response = observe_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Editor".into(),
                children: vec![ElementRecord {
                    role: "Edit".into(),
                    name: "Search".into(),
                    value: Some("filter text".into()),
                    bounds: Some(ElementBounds {
                        x: 10,
                        y: 20,
                        width: 240,
                        height: 32,
                    }),
                    states: vec!["enabled".into(), "focusable".into()],
                    children: vec![],
                }],
            }],
            &serde_json::json!({
                "goal": "search",
                "topK": 1,
            }),
        );

        assert_eq!(response["candidates"][0]["value"], "filter text");
        assert_eq!(
            response["candidates"][0]["states"],
            serde_json::json!(["enabled", "focusable"]),
        );
        assert_eq!(
            response["candidates"][0]["bounds"],
            serde_json::json!({
                "x": 10,
                "y": 20,
                "width": 240,
                "height": 32,
            }),
        );
    }

    #[test]
    fn assert_response_matches_top_level_window_text_and_visible_state() {
        let response = assert_response_from_windows(
            &[
                WindowRecord {
                    hwnd: "0x3".into(),
                    pid: 7,
                    title: "Alpha".into(),
                    children: vec![],
                },
                WindowRecord {
                    hwnd: "0x2".into(),
                    pid: 42,
                    title: "Beta Preferences".into(),
                    children: vec![],
                },
            ],
            &serde_json::json!({
                "text": "preferences",
                "app": "beta",
                "state": "visible",
            }),
        )
        .expect("asserted window");

        assert_eq!(
            response,
            serde_json::json!({
                "asserted": true,
                "via": "top_level_window_inventory",
                "checks": {
                    "text": "preferences",
                    "state": "visible",
                },
                "node": {
                    "role": "Window",
                    "name": "Beta Preferences",
                    "path": "Window[0]",
                    "scope": "pid-42",
                    "stable": "desktop-uia:pid-42:Window[0]",
                    "app": "Beta Preferences",
                    "pid": 42,
                    "states": ["visible"],
                    "metadata": {
                        "hwnd": "0x2",
                    },
                },
            }),
        );
    }

    #[test]
    fn assert_response_matches_descendant_text_value_and_enabled_state() {
        let response = assert_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![ElementRecord {
                    role: "Edit".into(),
                    name: "Display".into(),
                    value: Some("8".into()),
                    bounds: None,
                    states: vec!["focusable".into(), "enabled".into()],
                    children: vec![],
                }],
            }],
            &serde_json::json!({
                "role": "edit",
                "text": "8",
                "state": "enabled",
            }),
        )
        .expect("asserted descendant");

        assert_eq!(
            response,
            serde_json::json!({
                "asserted": true,
                "via": "native_descendant_tree",
                "checks": {
                    "text": "8",
                    "state": "enabled",
                },
                "node": {
                    "role": "Edit",
                    "name": "Display",
                    "value": "8",
                    "path": "Window[0]/Edit[0]",
                    "scope": "pid-42",
                    "stable": "desktop-uia:pid-42:Window[0]/Edit[0]",
                    "app": "Calculator",
                    "pid": 42,
                    "states": ["focusable", "enabled"],
                },
            }),
        );
    }

    #[test]
    fn assert_response_resolves_descendant_stable_ref() {
        let response = assert_response_from_windows(
            &[WindowRecord {
                hwnd: "0x2".into(),
                pid: 42,
                title: "Calculator".into(),
                children: vec![ElementRecord {
                    role: "Edit".into(),
                    name: "Display".into(),
                    value: Some("8".into()),
                    bounds: None,
                    states: vec!["focusable".into(), "enabled".into()],
                    children: vec![],
                }],
            }],
            &serde_json::json!({
                "ref": "desktop-uia:pid-42:Window[0]/Edit[0]",
                "text": "8",
                "state": "enabled",
            }),
        )
        .expect("asserted descendant ref");

        assert_eq!(
            response,
            serde_json::json!({
                "asserted": true,
                "via": "native_descendant_tree",
                "checks": {
                    "text": "8",
                    "state": "enabled",
                },
                "node": {
                    "role": "Edit",
                    "name": "Display",
                    "value": "8",
                    "path": "Window[0]/Edit[0]",
                    "scope": "pid-42",
                    "stable": "desktop-uia:pid-42:Window[0]/Edit[0]",
                    "app": "Calculator",
                    "pid": 42,
                    "states": ["focusable", "enabled"],
                },
            }),
        );
    }

    #[test]
    fn resolves_stable_top_level_window_refs_by_pid_and_pid_local_index() {
        let windows = [
            WindowRecord {
                hwnd: "0x1".into(),
                pid: 42,
                title: "Beta".into(),
                children: vec![],
            },
            WindowRecord {
                hwnd: "0x2".into(),
                pid: 7,
                title: "Alpha".into(),
                children: vec![],
            },
            WindowRecord {
                hwnd: "0x3".into(),
                pid: 42,
                title: "Beta Preferences".into(),
                children: vec![],
            },
        ];

        let resolved = resolve_top_level_window_ref(&windows, "desktop-uia:pid-42:Window[1]")
            .expect("stable window ref");

        assert_eq!(resolved.hwnd, "0x3");
        assert_eq!(resolved.title, "Beta Preferences");
    }

    #[test]
    fn uia_properties_create_normalized_descendant_record() {
        let record = element_record_from_uia_properties(UiaElementProperties {
            control_type_id: 50004,
            name: Some("Display".into()),
            value: Some("123".into()),
            bounds: Some(ElementBounds {
                x: 10,
                y: 20,
                width: 200,
                height: 32,
            }),
            enabled: true,
            focusable: true,
            horizontally_scrollable: false,
            vertically_scrollable: false,
        })
        .expect("normalized element");

        assert_eq!(
            record,
            ElementRecord {
                role: "Edit".into(),
                name: "Display".into(),
                value: Some("123".into()),
                bounds: Some(ElementBounds {
                    x: 10,
                    y: 20,
                    width: 200,
                    height: 32,
                }),
                states: vec!["enabled".into(), "focusable".into()],
                children: vec![],
            },
        );
    }

    #[test]
    fn uia_properties_include_scrollable_states() {
        let record = element_record_from_uia_properties(UiaElementProperties {
            control_type_id: 50033,
            name: Some("Results".into()),
            value: None,
            bounds: None,
            enabled: true,
            focusable: false,
            horizontally_scrollable: false,
            vertically_scrollable: true,
        })
        .expect("scrollable element");

        assert_eq!(record.role, "Pane");
        assert!(record.states.contains(&"vertically_scrollable".into()));
    }
}
