use std::collections::BTreeMap;
use std::env;
use std::fs;
#[cfg(target_os = "linux")]
use std::future::Future;
use std::path::PathBuf;
#[cfg(target_os = "linux")]
use std::pin::Pin;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::Value;
use unicli_shared::SidecarRequest;

use crate::errors::{backend_unavailable, AtspiError, HandlerResult};
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

pub fn handle_apps(_state: &mut State, _request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    let windows = enumerate_top_level_windows()?;
    Ok(apps_response_from_windows(&windows))
}

pub fn handle_windows(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    let windows = enumerate_top_level_windows()?;
    Ok(windows_response_from_windows(&windows, &request.params))
}

pub fn handle_snapshot(state: &mut State, request: &SidecarRequest) -> HandlerResult {
    state.refs_mut().clear();
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    let windows = enumerate_top_level_windows()?;
    Ok(snapshot_response_from_windows(&windows, &request.params))
}

pub fn handle_find(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    let windows = enumerate_top_level_windows()?;
    find_response_from_windows(&windows, &request.params)
}

pub fn handle_wait(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }

    let timeout = read_timeout(&request.params);
    let poll_interval = read_poll_interval(&request.params);
    let started = Instant::now();

    loop {
        let windows = enumerate_top_level_windows()?;
        if let Ok(response) = wait_response_from_windows(&windows, &request.params) {
            return Ok(response);
        }

        if started.elapsed() >= timeout {
            return Err(AtspiError::no_element("top-level window wait"));
        }

        sleep(poll_interval.min(timeout.saturating_sub(started.elapsed())));
    }
}

pub fn handle_observe(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    let windows = enumerate_top_level_windows()?;
    Ok(observe_response_from_windows(&windows, &request.params))
}

pub fn handle_assert(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }
    let windows = enumerate_top_level_windows()?;
    assert_response_from_windows(&windows, &request.params)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowRecord {
    pub(crate) id: String,
    pub(crate) pid: u32,
    pub(crate) title: String,
    pub(crate) desktop: String,
    pub(crate) host: String,
    pub(crate) bounds: Option<WindowBounds>,
    pub(crate) children: Vec<ElementRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowBounds {
    pub(crate) x: i32,
    pub(crate) y: i32,
    pub(crate) width: u32,
    pub(crate) height: u32,
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

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveAtspiNode {
    role: String,
    name: String,
    value: Option<String>,
    bounds: Option<ElementBounds>,
    states: Vec<String>,
    children: Vec<LiveAtspiNode>,
}

pub(crate) fn enumerate_top_level_windows() -> Result<Vec<WindowRecord>, AtspiError> {
    if !command_exists("wmctrl") {
        return enumerate_windows_from_atspi_only().ok_or_else(|| {
            AtspiError::unavailable("wmctrl is required for AT-SPI top-level app/window inventory")
        });
    }
    let output = Command::new("wmctrl")
        .args(["-lG", "-p"])
        .output()
        .map_err(|err| AtspiError::unavailable(format!("failed to run wmctrl -lG -p: {err}")))?;
    if !output.status.success() {
        return Err(AtspiError::unavailable(format!(
            "wmctrl -lG -p exited with status {}",
            output.status
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut windows = parse_wmctrl_windows(&stdout);
    if windows.is_empty() {
        if let Some(atspi_windows) = enumerate_windows_from_atspi_only() {
            return Ok(atspi_windows);
        }
    }
    if !windows.is_empty() {
        populate_live_atspi_descendants_best_effort(&mut windows);
    }
    Ok(windows)
}

fn parse_wmctrl_windows(output: &str) -> Vec<WindowRecord> {
    output
        .lines()
        .filter_map(parse_wmctrl_window_line)
        .collect()
}

fn parse_wmctrl_window_line(line: &str) -> Option<WindowRecord> {
    let mut fields = line.split_whitespace();
    let id = fields.next()?.to_string();
    let desktop = fields.next()?.to_string();
    let pid = fields.next()?.parse::<u32>().ok()?;
    let next = fields.next()?;
    let (bounds, host) = if let Ok(x) = next.parse::<i32>() {
        let y = fields.next()?.parse::<i32>().ok()?;
        let width = fields.next()?.parse::<u32>().ok()?;
        let height = fields.next()?.parse::<u32>().ok()?;
        let host = fields.next()?.to_string();
        (
            Some(WindowBounds {
                x,
                y,
                width,
                height,
            }),
            host,
        )
    } else {
        (None, next.to_string())
    };
    let title = fields.collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    Some(WindowRecord {
        id,
        pid,
        title,
        desktop,
        host,
        bounds,
        children: Vec::new(),
    })
}

#[cfg(target_os = "linux")]
fn enumerate_windows_from_atspi_only() -> Option<Vec<WindowRecord>> {
    match futures_lite::future::block_on(collect_all_live_atspi_window_roots()) {
        Ok(roots) => {
            let windows = window_records_from_live_roots(roots);
            (!windows.is_empty()).then_some(windows)
        }
        Err(err) => {
            tracing::debug!(?err, "skipping AT-SPI-only top-level inventory");
            None
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn enumerate_windows_from_atspi_only() -> Option<Vec<WindowRecord>> {
    None
}

#[cfg(any(target_os = "linux", test))]
fn window_records_from_live_roots(roots: Vec<LiveAtspiNode>) -> Vec<WindowRecord> {
    roots
        .into_iter()
        .enumerate()
        .filter_map(|(index, root)| {
            if !is_live_window_role(&root.role) || root.name.is_empty() {
                return None;
            }
            Some(WindowRecord {
                id: format!("atspi-root-{index}"),
                pid: u32::MAX.saturating_sub(index as u32),
                title: root.name,
                desktop: "atspi".into(),
                host: "atspi".into(),
                bounds: root.bounds.map(|bounds| WindowBounds {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height,
                }),
                children: root
                    .children
                    .iter()
                    .map(element_record_from_live_node)
                    .collect(),
            })
        })
        .collect()
}

#[cfg(any(target_os = "linux", test))]
fn is_live_window_role(role: &str) -> bool {
    matches!(
        normalize_atspi_label(role).as_str(),
        "frame" | "window" | "dialog"
    )
}

#[cfg(any(target_os = "linux", test))]
fn populate_window_descendants_from_live_roots(
    windows: &mut [WindowRecord],
    roots: Vec<LiveAtspiNode>,
) {
    for window in windows {
        let Some(root) = roots
            .iter()
            .find(|candidate| live_node_matches_window(candidate, window))
        else {
            continue;
        };
        if window.bounds.is_none() {
            window.bounds = root.bounds.as_ref().map(|bounds| WindowBounds {
                x: bounds.x,
                y: bounds.y,
                width: bounds.width,
                height: bounds.height,
            });
        }
        window.children = root
            .children
            .iter()
            .map(element_record_from_live_node)
            .collect();
    }
}

#[cfg(any(target_os = "linux", test))]
fn live_node_matches_window(node: &LiveAtspiNode, window: &WindowRecord) -> bool {
    is_live_window_role(&node.role)
        && (node.name == window.title
            || (!node.name.is_empty() && window.title.contains(&node.name))
            || (!window.title.is_empty() && node.name.contains(&window.title)))
}

#[cfg(any(target_os = "linux", test))]
fn element_record_from_live_node(node: &LiveAtspiNode) -> ElementRecord {
    ElementRecord {
        role: normalize_atspi_label(&node.role),
        name: node.name.clone(),
        value: node.value.clone(),
        bounds: node.bounds.clone(),
        states: node
            .states
            .iter()
            .map(|state| normalize_atspi_label(state))
            .filter(|state| !state.is_empty())
            .collect(),
        children: node
            .children
            .iter()
            .map(element_record_from_live_node)
            .collect(),
    }
}

#[cfg(any(target_os = "linux", test))]
fn normalize_atspi_label(value: &str) -> String {
    let mut normalized = String::new();
    let mut previous_was_separator = false;
    let mut previous_was_lower_or_digit = false;

    for character in value.chars() {
        if character.is_ascii_uppercase() {
            if previous_was_lower_or_digit && !previous_was_separator {
                normalized.push('_');
            }
            normalized.push(character.to_ascii_lowercase());
            previous_was_separator = false;
            previous_was_lower_or_digit = true;
        } else if character.is_ascii_alphanumeric() {
            normalized.push(character.to_ascii_lowercase());
            previous_was_separator = false;
            previous_was_lower_or_digit =
                character.is_ascii_lowercase() || character.is_ascii_digit();
        } else if !normalized.is_empty() && !previous_was_separator {
            normalized.push('_');
            previous_was_separator = true;
            previous_was_lower_or_digit = false;
        }
    }

    normalized.trim_matches('_').to_string()
}

#[cfg(target_os = "linux")]
fn populate_live_atspi_descendants_best_effort(windows: &mut [WindowRecord]) {
    match futures_lite::future::block_on(collect_live_atspi_window_roots(windows)) {
        Ok(roots) => populate_window_descendants_from_live_roots(windows, roots),
        Err(err) => tracing::debug!(?err, "skipping live AT-SPI descendant population"),
    }
}

#[cfg(not(target_os = "linux"))]
fn populate_live_atspi_descendants_best_effort(_windows: &mut [WindowRecord]) {}

#[cfg(target_os = "linux")]
async fn collect_live_atspi_window_roots(
    windows: &[WindowRecord],
) -> Result<Vec<LiveAtspiNode>, atspi::AtspiError> {
    use atspi::proxy::accessible::ObjectRefExt;
    use std::collections::VecDeque;

    const MAX_SEARCH_NODES: usize = 4_000;
    const MAX_SEARCH_DEPTH: usize = 8;
    const MAX_CHILD_DEPTH: usize = 8;
    const MAX_CHILD_NODES: usize = 2_000;

    let connection = atspi::AccessibilityConnection::new().await?;
    let root = connection.root_accessible_on_registry().await?;
    let conn = connection.connection();
    let mut queue: VecDeque<_> = root
        .get_children()
        .await?
        .into_iter()
        .map(|object| (object, 0usize))
        .collect();
    let mut visited = 0usize;
    let mut roots = Vec::new();

    while let Some((object_ref, depth)) = queue.pop_front() {
        if visited >= MAX_SEARCH_NODES || roots.len() >= windows.len() {
            break;
        }
        visited += 1;

        let accessible = match object_ref.into_accessible_proxy(conn).await {
            Ok(accessible) => accessible,
            Err(_) => continue,
        };
        let role = live_accessible_role(&accessible).await;
        let name = accessible.name().await.unwrap_or_default();

        if live_accessible_matches_window(&role, &name, windows) {
            let mut budget = MAX_CHILD_NODES;
            roots.push(
                live_node_from_accessible(
                    conn,
                    accessible,
                    role,
                    name,
                    MAX_CHILD_DEPTH,
                    &mut budget,
                )
                .await?,
            );
            continue;
        }

        if depth >= MAX_SEARCH_DEPTH {
            continue;
        }
        for child_ref in accessible.get_children().await.unwrap_or_default() {
            queue.push_back((child_ref, depth + 1));
        }
    }

    Ok(roots)
}

#[cfg(target_os = "linux")]
async fn collect_all_live_atspi_window_roots() -> Result<Vec<LiveAtspiNode>, atspi::AtspiError> {
    use atspi::proxy::accessible::ObjectRefExt;
    use std::collections::VecDeque;

    const MAX_SEARCH_NODES: usize = 4_000;
    const MAX_SEARCH_DEPTH: usize = 8;
    const MAX_CHILD_DEPTH: usize = 8;
    const MAX_CHILD_NODES: usize = 2_000;

    let connection = atspi::AccessibilityConnection::new().await?;
    let root = connection.root_accessible_on_registry().await?;
    let conn = connection.connection();
    let mut queue: VecDeque<_> = root
        .get_children()
        .await?
        .into_iter()
        .map(|object| (object, 0usize))
        .collect();
    let mut visited = 0usize;
    let mut roots = Vec::new();

    while let Some((object_ref, depth)) = queue.pop_front() {
        if visited >= MAX_SEARCH_NODES {
            break;
        }
        visited += 1;

        let accessible = match object_ref.into_accessible_proxy(conn).await {
            Ok(accessible) => accessible,
            Err(_) => continue,
        };
        let role = live_accessible_role(&accessible).await;
        let name = accessible.name().await.unwrap_or_default();

        if is_live_window_role(&role) {
            let mut budget = MAX_CHILD_NODES;
            roots.push(
                live_node_from_accessible(
                    conn,
                    accessible,
                    role,
                    name,
                    MAX_CHILD_DEPTH,
                    &mut budget,
                )
                .await?,
            );
            continue;
        }

        if depth >= MAX_SEARCH_DEPTH {
            continue;
        }
        for child_ref in accessible.get_children().await.unwrap_or_default() {
            queue.push_back((child_ref, depth + 1));
        }
    }

    Ok(roots)
}

#[cfg(target_os = "linux")]
async fn live_accessible_role(
    accessible: &atspi::proxy::accessible::AccessibleProxy<'_>,
) -> String {
    match accessible.get_role().await {
        Ok(role) => role.name().to_string(),
        Err(_) => accessible.get_role_name().await.unwrap_or_default(),
    }
}

#[cfg(target_os = "linux")]
fn live_accessible_matches_window(role: &str, name: &str, windows: &[WindowRecord]) -> bool {
    let node = LiveAtspiNode {
        role: role.to_string(),
        name: name.to_string(),
        value: None,
        bounds: None,
        states: Vec::new(),
        children: Vec::new(),
    };
    windows
        .iter()
        .any(|window| live_node_matches_window(&node, window))
}

#[cfg(target_os = "linux")]
fn live_node_from_accessible<'a>(
    conn: &'a zbus::Connection,
    accessible: atspi::proxy::accessible::AccessibleProxy<'a>,
    role: String,
    name: String,
    depth_remaining: usize,
    budget: &'a mut usize,
) -> Pin<Box<dyn Future<Output = Result<LiveAtspiNode, atspi::AtspiError>> + Send + 'a>> {
    use atspi::proxy::accessible::ObjectRefExt;
    use atspi::proxy::proxy_ext::ProxyExt;

    Box::pin(async move {
        if *budget == 0 {
            return Ok(LiveAtspiNode {
                role,
                name,
                value: None,
                bounds: None,
                states: Vec::new(),
                children: Vec::new(),
            });
        }
        *budget -= 1;

        let proxies = accessible.proxies().await.ok();
        let bounds = if let Some(proxies) = &proxies {
            match proxies.component().await {
                Ok(component) => component
                    .get_extents(atspi::CoordType::Screen)
                    .await
                    .ok()
                    .and_then(|(x, y, width, height)| element_bounds_from_i32(x, y, width, height)),
                Err(_) => None,
            }
        } else {
            None
        };
        let value = live_accessible_value(&proxies).await;
        let states = accessible
            .get_state()
            .await
            .map(|states| {
                states
                    .into_iter()
                    .map(|state| format!("{state:?}"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut children = Vec::new();

        if depth_remaining > 0 && *budget > 0 {
            for child_ref in accessible.get_children().await.unwrap_or_default() {
                if *budget == 0 {
                    break;
                }
                let child = match child_ref.into_accessible_proxy(conn).await {
                    Ok(child) => child,
                    Err(_) => continue,
                };
                let child_role = live_accessible_role(&child).await;
                let child_name = child.name().await.unwrap_or_default();
                children.push(
                    live_node_from_accessible(
                        conn,
                        child,
                        child_role,
                        child_name,
                        depth_remaining - 1,
                        budget,
                    )
                    .await?,
                );
            }
        }

        Ok(LiveAtspiNode {
            role,
            name,
            value,
            bounds,
            states,
            children,
        })
    })
}

#[cfg(target_os = "linux")]
async fn live_accessible_value(
    proxies: &Option<atspi::proxy::proxy_ext::Proxies<'_>>,
) -> Option<String> {
    if let Some(proxies) = proxies {
        if let Ok(text) = proxies.text().await {
            if let Ok(count) = text.character_count().await {
                if count > 0 {
                    if let Ok(value) = text.get_text(0, count.min(4096)).await {
                        if !value.is_empty() {
                            return Some(value);
                        }
                    }
                }
            }
        }
        if let Ok(value) = proxies.value().await {
            if let Ok(text) = value.text().await {
                if !text.is_empty() {
                    return Some(text);
                }
            }
            if let Ok(current) = value.current_value().await {
                return Some(current.to_string());
            }
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn element_bounds_from_i32(x: i32, y: i32, width: i32, height: i32) -> Option<ElementBounds> {
    Some(ElementBounds {
        x,
        y,
        width: width.try_into().ok()?,
        height: height.try_into().ok()?,
    })
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
                "id": window.id,
                "name": window.title,
                "title": window.title,
                "pid": window.pid,
                "desktop": window.desktop,
                "host": window.host,
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
            window_node(window, index, true)
        })
        .collect();

    serde_json::json!({
        "role": "Desktop",
        "name": "Linux Desktop",
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
            .ok_or_else(|| AtspiError::no_element("top-level window query"));
    }

    Ok(serde_json::json!(matches))
}

fn wait_response_from_windows(windows: &[WindowRecord], params: &Value) -> HandlerResult {
    let (via, node) = first_matching_node(windows, params)
        .ok_or_else(|| AtspiError::no_element("top-level window query"))?;

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
        if !stable.starts_with("desktop-atspi:") {
            return Err(AtspiError::invalid_input(
                "atspi_assert requires a desktop-atspi stable ref when ref is provided",
            ));
        }
        let (via, node) = assert_target_ref_node(windows, stable, params)
            .ok_or_else(|| AtspiError::no_element(stable.to_string()))?;

        return Ok(serde_json::json!({
            "asserted": true,
            "via": via,
            "checks": assertion_checks(params),
            "node": node,
        }));
    }

    let (via, node) = first_assertion_node(windows, params)
        .ok_or_else(|| AtspiError::no_element("top-level window assertion"))?;

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

pub(crate) fn resolve_top_level_window_ref<'a>(
    windows: &'a [WindowRecord],
    stable: &str,
) -> Option<&'a WindowRecord> {
    let (scope, path) = stable.strip_prefix("desktop-atspi:")?.split_once(':')?;
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
    let (scope, path) = stable.strip_prefix("desktop-atspi:")?.split_once(':')?;
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

fn pid_local_window_index(windows: &[WindowRecord], target: &WindowRecord) -> usize {
    windows
        .iter()
        .filter(|window| window.pid == target.pid)
        .position(|window| window.id == target.id)
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
            "id": window.id,
            "desktop": window.desktop,
            "host": window.host,
        },
    });

    if include_stable {
        node["stable"] = serde_json::json!(window_stable(window, index));
    }
    if let Some(bounds) = &window.bounds {
        node["bounds"] = serde_json::json!({
            "x": bounds.x,
            "y": bounds.y,
            "width": bounds.width,
            "height": bounds.height,
        });
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
    format!("desktop-atspi:pid-{}:Window[{index}]", window.pid)
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
        node["stable"] = serde_json::json!(format!("desktop-atspi:{scope}:{path}"));
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
            let stable = format!("desktop-atspi:{scope}:{path}");
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
        || element
            .states
            .iter()
            .any(|state| matches!(state.as_str(), "horizontal" | "vertical" | "scrollable"))
}

fn element_is_settable(element: &ElementRecord) -> bool {
    let role = element.role.to_ascii_lowercase();
    role.contains("edit")
        || role.contains("text")
        || role.contains("slider")
        || role.contains("spin_button")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apps_response_groups_wmctrl_windows_by_pid() {
        let windows = parse_wmctrl_windows(
            "0x03a00007  0 1234 host Terminal\n0x03a00008  0 1234 host Terminal Settings\n0x04b00001 -1 77 host Notes\n",
        );

        assert_eq!(
            apps_response_from_windows(&windows),
            serde_json::json!({
                "mode": "apps",
                "count": 2,
                "apps": [
                    { "name": "Notes", "pid": 77, "windowCount": 1 },
                    { "name": "Terminal", "pid": 1234, "windowCount": 2 },
                ],
            }),
        );
    }

    #[test]
    fn snapshot_response_emits_raw_ax_root_with_window_children() {
        let windows =
            parse_wmctrl_windows("0x03a00007  0 1234 host Terminal\n0x04b00001 -1 77 host Notes\n");

        assert_eq!(
            snapshot_response_from_windows(&windows, &serde_json::json!({})),
            serde_json::json!({
                "role": "Desktop",
                "name": "Linux Desktop",
                "path": "Desktop[0]",
                "scope": "desktop",
                "children": [
                    {
                        "role": "Window",
                        "name": "Terminal",
                        "path": "Window[0]",
                        "scope": "pid-1234",
                        "app": "Terminal",
                        "pid": 1234,
                        "states": ["visible"],
                        "metadata": {
                            "id": "0x03a00007",
                            "desktop": "0",
                            "host": "host",
                        },
                        "stable": "desktop-atspi:pid-1234:Window[0]",
                    },
                    {
                        "role": "Window",
                        "name": "Notes",
                        "path": "Window[0]",
                        "scope": "pid-77",
                        "app": "Notes",
                        "pid": 77,
                        "states": ["visible"],
                        "metadata": {
                            "id": "0x04b00001",
                            "desktop": "-1",
                            "host": "host",
                        },
                        "stable": "desktop-atspi:pid-77:Window[0]",
                    },
                ],
            }),
        );
    }

    #[test]
    fn snapshot_response_exposes_wmctrl_geometry_when_available() {
        let windows = parse_wmctrl_windows("0x03a00007  0 1234 10 20 640 480 host Terminal\n");

        assert_eq!(
            snapshot_response_from_windows(&windows, &serde_json::json!({})),
            serde_json::json!({
                "role": "Desktop",
                "name": "Linux Desktop",
                "path": "Desktop[0]",
                "scope": "desktop",
                "children": [
                    {
                        "role": "Window",
                        "name": "Terminal",
                        "path": "Window[0]",
                        "scope": "pid-1234",
                        "app": "Terminal",
                        "pid": 1234,
                        "bounds": {
                            "x": 10,
                            "y": 20,
                            "width": 640,
                            "height": 480,
                        },
                        "states": ["visible"],
                        "metadata": {
                            "id": "0x03a00007",
                            "desktop": "0",
                            "host": "host",
                        },
                        "stable": "desktop-atspi:pid-1234:Window[0]",
                    },
                ],
            }),
        );
    }

    #[test]
    fn snapshot_response_emits_descendant_bounds() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Calculator\n");
        windows[0].children = vec![ElementRecord {
            role: "push_button".into(),
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
        }];

        let response = snapshot_response_from_windows(&windows, &serde_json::json!({}));

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
    fn live_atspi_roots_populate_matching_window_descendants() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Calculator\n");
        populate_window_descendants_from_live_roots(
            &mut windows,
            vec![LiveAtspiNode {
                role: "frame".into(),
                name: "Calculator".into(),
                value: None,
                bounds: Some(ElementBounds {
                    x: 10,
                    y: 20,
                    width: 640,
                    height: 480,
                }),
                states: vec!["active".into(), "showing".into()],
                children: vec![
                    LiveAtspiNode {
                        role: "push button".into(),
                        name: "Eight".into(),
                        value: None,
                        bounds: Some(ElementBounds {
                            x: 120,
                            y: 220,
                            width: 44,
                            height: 36,
                        }),
                        states: vec!["enabled".into(), "sensitive".into()],
                        children: vec![],
                    },
                    LiveAtspiNode {
                        role: "text".into(),
                        name: "Display".into(),
                        value: Some("8".into()),
                        bounds: None,
                        states: vec!["focusable".into(), "enabled".into()],
                        children: vec![],
                    },
                ],
            }],
        );

        let response = snapshot_response_from_windows(&windows, &serde_json::json!({}));

        assert_eq!(
            response["children"][0]["children"],
            serde_json::json!([
                {
                    "role": "push_button",
                    "name": "Eight",
                    "path": "Window[0]/push_button[0]",
                    "scope": "pid-1234",
                    "app": "Calculator",
                    "pid": 1234,
                    "states": ["enabled", "sensitive"],
                    "bounds": {
                        "x": 120,
                        "y": 220,
                        "width": 44,
                        "height": 36,
                    },
                    "stable": "desktop-atspi:pid-1234:Window[0]/push_button[0]",
                },
                {
                    "role": "text",
                    "name": "Display",
                    "value": "8",
                    "path": "Window[0]/text[0]",
                    "scope": "pid-1234",
                    "app": "Calculator",
                    "pid": 1234,
                    "states": ["focusable", "enabled"],
                    "stable": "desktop-atspi:pid-1234:Window[0]/text[0]",
                },
            ]),
        );
    }

    #[test]
    fn live_atspi_roots_can_create_windows_without_wmctrl_inventory() {
        let windows = window_records_from_live_roots(vec![LiveAtspiNode {
            role: "dialog".into(),
            name: "Preferences".into(),
            value: None,
            bounds: Some(ElementBounds {
                x: 30,
                y: 40,
                width: 500,
                height: 360,
            }),
            states: vec!["showing".into(), "enabled".into()],
            children: vec![LiveAtspiNode {
                role: "check box".into(),
                name: "Enable sync".into(),
                value: None,
                bounds: None,
                states: vec!["checked".into()],
                children: vec![],
            }],
        }]);

        assert_eq!(
            windows,
            vec![WindowRecord {
                id: "atspi-root-0".into(),
                pid: u32::MAX,
                title: "Preferences".into(),
                desktop: "atspi".into(),
                host: "atspi".into(),
                bounds: Some(WindowBounds {
                    x: 30,
                    y: 40,
                    width: 500,
                    height: 360,
                }),
                children: vec![ElementRecord {
                    role: "check_box".into(),
                    name: "Enable sync".into(),
                    value: None,
                    bounds: None,
                    states: vec!["checked".into()],
                    children: vec![],
                }],
            }],
        );
    }

    #[test]
    fn find_response_returns_first_matching_top_level_window() {
        let response = find_response_from_windows(
            &parse_wmctrl_windows(
                "0x03a00007  0 1234 host Terminal\n0x03a00008  0 1234 host Terminal Settings\n0x04b00001 -1 77 host Notes\n",
            ),
            &serde_json::json!({
                "role": "window",
                "name": "settings",
                "app": "terminal",
                "first": true,
            }),
        )
        .expect("matching window");

        assert_eq!(
            response,
            serde_json::json!({
                "role": "Window",
                "name": "Terminal Settings",
                "path": "Window[1]",
                "scope": "pid-1234",
                "app": "Terminal Settings",
                "pid": 1234,
                "states": ["visible"],
                "metadata": {
                    "id": "0x03a00008",
                    "desktop": "0",
                    "host": "host",
                },
                "stable": "desktop-atspi:pid-1234:Window[1]",
            }),
        );
    }

    #[test]
    fn find_response_returns_descendant_by_role_name_and_value() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Calculator\n");
        windows[0].children = vec![
            ElementRecord {
                role: "push_button".into(),
                name: "Eight".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
            ElementRecord {
                role: "text".into(),
                name: "Display".into(),
                value: Some("8".into()),
                bounds: None,
                states: vec!["focusable".into(), "enabled".into()],
                children: vec![],
            },
        ];

        let response = find_response_from_windows(
            &windows,
            &serde_json::json!({
                "role": "text",
                "text": "8",
                "first": true,
            }),
        )
        .expect("matching descendant");

        assert_eq!(
            response,
            serde_json::json!({
                "role": "text",
                "name": "Display",
                "value": "8",
                "path": "Window[0]/text[0]",
                "scope": "pid-1234",
                "stable": "desktop-atspi:pid-1234:Window[0]/text[0]",
                "app": "Calculator",
                "pid": 1234,
                "states": ["focusable", "enabled"],
            }),
        );
    }

    #[test]
    fn wait_response_returns_first_matching_top_level_window() {
        let response = wait_response_from_windows(
            &parse_wmctrl_windows(
                "0x03a00007  0 1234 host Terminal\n0x03a00008  0 1234 host Terminal Settings\n0x04b00001 -1 77 host Notes\n",
            ),
            &serde_json::json!({
                "role": "window",
                "name": "settings",
                "app": "terminal",
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
                    "name": "Terminal Settings",
                    "path": "Window[1]",
                    "scope": "pid-1234",
                    "app": "Terminal Settings",
                    "pid": 1234,
                    "states": ["visible"],
                    "metadata": {
                        "id": "0x03a00008",
                        "desktop": "0",
                        "host": "host",
                    },
                    "stable": "desktop-atspi:pid-1234:Window[1]",
                },
            }),
        );
    }

    #[test]
    fn wait_response_returns_matching_descendant_by_value() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Calculator\n");
        windows[0].children = vec![ElementRecord {
            role: "text".into(),
            name: "Display".into(),
            value: Some("8".into()),
            bounds: None,
            states: vec!["focusable".into(), "enabled".into()],
            children: vec![],
        }];

        let response = wait_response_from_windows(
            &windows,
            &serde_json::json!({
                "role": "text",
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
                    "role": "text",
                    "name": "Display",
                    "value": "8",
                    "path": "Window[0]/text[0]",
                    "scope": "pid-1234",
                    "stable": "desktop-atspi:pid-1234:Window[0]/text[0]",
                    "app": "Calculator",
                    "pid": 1234,
                    "states": ["focusable", "enabled"],
                },
            }),
        );
    }

    #[test]
    fn observe_response_ranks_top_level_windows_by_goal() {
        let response = observe_response_from_windows(
            &parse_wmctrl_windows(
                "0x03a00007  0 1234 host Terminal\n0x03a00008  0 1234 host Terminal Settings\n0x04b00001 -1 77 host Notes\n",
            ),
            &serde_json::json!({
                "goal": "terminal settings",
                "topK": 1,
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "goal": "terminal settings",
                "count": 1,
                "candidates": [
                    {
                        "action": "click",
                        "ref": "desktop-atspi:pid-1234:Window[1]",
                        "stable": "desktop-atspi:pid-1234:Window[1]",
                        "role": "Window",
                        "name": "Terminal Settings",
                        "confidence": 0.95,
                        "reason": "exact title match",
                    },
                ],
            }),
        );
    }

    #[test]
    fn observe_response_ranks_descendant_elements_by_goal() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Calculator\n");
        windows[0].children = vec![
            ElementRecord {
                role: "push_button".into(),
                name: "Five".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
            ElementRecord {
                role: "push_button".into(),
                name: "Eight".into(),
                value: None,
                bounds: None,
                states: vec!["enabled".into()],
                children: vec![],
            },
        ];

        let response = observe_response_from_windows(
            &windows,
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
                        "ref": "desktop-atspi:pid-1234:Window[0]/push_button[1]",
                        "stable": "desktop-atspi:pid-1234:Window[0]/push_button[1]",
                        "role": "push_button",
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
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Terminal Settings\n");
        windows[0].children = vec![ElementRecord {
            role: "scroll_pane".into(),
            name: "Output".into(),
            value: None,
            bounds: None,
            states: vec!["enabled".into(), "vertical".into()],
            children: vec![],
        }];

        let response = observe_response_from_windows(
            &windows,
            &serde_json::json!({
                "goal": "output",
                "topK": 1,
            }),
        );

        assert_eq!(response["candidates"][0]["action"], "scroll");
        assert_eq!(
            response["candidates"][0]["stable"],
            "desktop-atspi:pid-1234:Window[0]/scroll_pane[0]",
        );
    }

    #[test]
    fn observe_response_marks_range_descendant_action_as_set_value() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Terminal Settings\n");
        windows[0].children = vec![ElementRecord {
            role: "slider".into(),
            name: "Volume".into(),
            value: Some("35".into()),
            bounds: None,
            states: vec!["enabled".into()],
            children: vec![],
        }];

        let response = observe_response_from_windows(
            &windows,
            &serde_json::json!({
                "goal": "volume",
                "topK": 1,
            }),
        );

        assert_eq!(response["candidates"][0]["action"], "set_value");
        assert_eq!(
            response["candidates"][0]["stable"],
            "desktop-atspi:pid-1234:Window[0]/slider[0]",
        );
    }

    #[test]
    fn observe_response_preserves_descendant_value_states_and_bounds() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Editor\n");
        windows[0].children = vec![ElementRecord {
            role: "text".into(),
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
        }];

        let response = observe_response_from_windows(
            &windows,
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
            &parse_wmctrl_windows(
                "0x03a00007  0 1234 host Terminal\n0x03a00008  0 1234 host Terminal Settings\n0x04b00001 -1 77 host Notes\n",
            ),
            &serde_json::json!({
                "text": "settings",
                "app": "terminal",
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
                    "text": "settings",
                    "state": "visible",
                },
                "node": {
                    "role": "Window",
                    "name": "Terminal Settings",
                    "path": "Window[1]",
                    "scope": "pid-1234",
                    "app": "Terminal Settings",
                    "pid": 1234,
                    "states": ["visible"],
                    "metadata": {
                        "id": "0x03a00008",
                        "desktop": "0",
                        "host": "host",
                    },
                    "stable": "desktop-atspi:pid-1234:Window[1]",
                },
            }),
        );
    }

    #[test]
    fn assert_response_matches_descendant_text_value_and_enabled_state() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Calculator\n");
        windows[0].children = vec![ElementRecord {
            role: "text".into(),
            name: "Display".into(),
            value: Some("8".into()),
            bounds: None,
            states: vec!["focusable".into(), "enabled".into()],
            children: vec![],
        }];

        let response = assert_response_from_windows(
            &windows,
            &serde_json::json!({
                "role": "text",
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
                    "role": "text",
                    "name": "Display",
                    "value": "8",
                    "path": "Window[0]/text[0]",
                    "scope": "pid-1234",
                    "stable": "desktop-atspi:pid-1234:Window[0]/text[0]",
                    "app": "Calculator",
                    "pid": 1234,
                    "states": ["focusable", "enabled"],
                },
            }),
        );
    }

    #[test]
    fn assert_response_resolves_descendant_stable_ref() {
        let mut windows = parse_wmctrl_windows("0x03a00007  0 1234 host Calculator\n");
        windows[0].children = vec![ElementRecord {
            role: "text".into(),
            name: "Display".into(),
            value: Some("8".into()),
            bounds: None,
            states: vec!["focusable".into(), "enabled".into()],
            children: vec![],
        }];

        let response = assert_response_from_windows(
            &windows,
            &serde_json::json!({
                "ref": "desktop-atspi:pid-1234:Window[0]/text[0]",
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
                    "role": "text",
                    "name": "Display",
                    "value": "8",
                    "path": "Window[0]/text[0]",
                    "scope": "pid-1234",
                    "stable": "desktop-atspi:pid-1234:Window[0]/text[0]",
                    "app": "Calculator",
                    "pid": 1234,
                    "states": ["focusable", "enabled"],
                },
            }),
        );
    }

    #[test]
    fn resolves_stable_top_level_window_refs_by_pid_and_pid_local_index() {
        let windows = parse_wmctrl_windows(
            "0x03a00007  0 1234 host Terminal\n0x03a00008  0 1234 host Terminal Settings\n0x04b00001 -1 77 host Notes\n",
        );

        let resolved = resolve_top_level_window_ref(&windows, "desktop-atspi:pid-1234:Window[1]")
            .expect("stable window ref");

        assert_eq!(resolved.id, "0x03a00008");
        assert_eq!(resolved.title, "Terminal Settings");
    }
}
