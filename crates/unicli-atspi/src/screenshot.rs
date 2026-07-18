//! @owner       crates::unicli-atspi::screenshot
//! @does        Capture Linux desktop, exact top-level-window, or resolved-element screenshots through the active display server.
//! @needs       AT-SPI window enumeration/ref resolution, grim, gnome-screenshot, ImageMagick import, X11 xdotool
//! @feeds       desktop-atspi compute screenshot responses
//! @breaks      Ignoring an explicit app, pid, or native window id can capture an unrelated foreground surface.
//! @invariants  Explicit targets are validated before enumeration; exact window requests never broaden to the first available window; helpers write only request-owned temporary files and every outcome attempts cleanup.
//! @side-effects Runs platform screenshot subprocesses and writes then removes one temporary PNG; the host transport owns final-path publication.
//! @perf        One native enumeration plus one screenshot subprocess per request.
//! @concurrency Each request owns its output path; shared desktop state is observed but not mutated.
//! @test        cargo test -p unicli-atspi
//! @stability   internal
//! @since       0.400.2

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use unicli_shared::SidecarRequest;

use crate::errors::{backend_unavailable, AtspiError, HandlerResult};
use crate::tree::{
    enumerate_top_level_windows, resolve_descendant_element_ref, resolve_top_level_window_ref,
    validate_window_target_params, window_matches_params, ElementBounds, ElementRecord, State,
    WindowRecord,
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

pub fn handle(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "linux") {
        return Err(backend_unavailable());
    }

    let stable = read_optional_stable_ref(&request.params)?;
    if let Some(stable) = stable {
        let windows = enumerate_top_level_windows()?;
        if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, &stable) {
            let bounds = require_descendant_bounds(element, &stable)?;
            let screenshot = capture_region_screenshot(&request.params, bounds)?;
            return Ok(screenshot_response_for_descendant(
                window, element, &stable, &path, screenshot,
            ));
        }
        let window = resolve_top_level_window_ref(&windows, &stable)
            .ok_or_else(|| AtspiError::no_element(stable.clone()))?;
        let screenshot = capture_window_screenshot(&request.params, window)?;
        return Ok(screenshot_response_for_window(window, &stable, screenshot));
    }

    if has_explicit_window_target(&request.params) {
        let windows = enumerate_top_level_windows()?;
        let window = resolve_requested_window(&windows, &request.params)?;
        let screenshot = capture_window_screenshot(&request.params, window)?;
        return Ok(screenshot_response_for_window(
            window,
            &format!(
                "desktop-atspi:window-{}:Window[0]",
                window.id.to_ascii_lowercase()
            ),
            screenshot,
        ));
    }

    capture_screenshot(&request.params)
}

fn has_explicit_window_target(params: &Value) -> bool {
    ["app", "pid", "windowId", "bundleId", "processName"]
        .iter()
        .any(|key| params.get(*key).is_some())
}

fn resolve_requested_window<'a>(
    windows: &'a [WindowRecord],
    params: &Value,
) -> Result<&'a WindowRecord, AtspiError> {
    validate_window_target_params(params)?;
    let matches: Vec<&WindowRecord> = windows
        .iter()
        .filter(|window| window_matches_params(window, params))
        .collect();
    match matches.as_slice() {
        [window] => Ok(*window),
        [] => Err(AtspiError::target_not_found("screenshot window target")),
        _ => Err(AtspiError::target_ambiguous(
            "screenshot window target",
            matches.len(),
        )),
    }
}

fn capture_screenshot(params: &Value) -> HandlerResult {
    reject_requested_path(params)?;
    let path = temporary_screenshot_path().to_string_lossy().into_owned();
    let plan = screenshot_command_for(display_server_from_env(), &path, command_exists)?;
    capture_temporary_png(&plan, &path)
}

fn capture_window_screenshot(params: &Value, window: &WindowRecord) -> HandlerResult {
    reject_requested_path(params)?;
    let path = temporary_screenshot_path().to_string_lossy().into_owned();
    let plan = window_screenshot_command_for(
        display_server_from_env(),
        &path,
        &window.id,
        window.bounds.as_ref(),
        command_exists,
    )?;

    let mut response = capture_temporary_png(&plan, &path)?;

    response["scope"] = serde_json::json!("window");
    response["windowId"] = serde_json::json!(window.id);

    Ok(response)
}

fn capture_region_screenshot(params: &Value, bounds: &ElementBounds) -> HandlerResult {
    reject_requested_path(params)?;
    let path = temporary_screenshot_path().to_string_lossy().into_owned();
    let plan =
        region_screenshot_command_for(display_server_from_env(), &path, bounds, command_exists)?;

    let mut response = capture_temporary_png(&plan, &path)?;
    response["scope"] = serde_json::json!("region");
    response["bounds"] = bounds_node(bounds);
    Ok(response)
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
        "atspi_screenshot requires a desktop-atspi stable top-level window ref when ref is provided",
    ))
}

fn screenshot_response_for_window(
    window: &WindowRecord,
    stable: &str,
    screenshot: serde_json::Value,
) -> serde_json::Value {
    let mut response = serde_json::json!({
        "captured": true,
        "via": "top_level_window_screenshot_helper",
        "stable": stable,
        "id": window.id,
        "windowId": window.id,
        "pid": window.pid,
        "title": window.title,
        "screenshot": screenshot,
    });
    if let Some(bounds) = &window.bounds {
        response["bounds"] = serde_json::json!({
            "x": bounds.x,
            "y": bounds.y,
            "width": bounds.width,
            "height": bounds.height,
        });
    }
    response
}

fn screenshot_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    screenshot: serde_json::Value,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "captured": true,
        "via": "descendant_bounds_screenshot_helper",
        "stable": stable,
        "id": window.id,
        "windowId": window.id,
        "pid": window.pid,
        "title": window.title,
        "target": target,
        "screenshot": screenshot,
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

fn reject_requested_path(params: &Value) -> Result<(), AtspiError> {
    if params.get("path").is_some() {
        return Err(AtspiError::invalid_input(
            "AT-SPI screenshot path publication is owned by the host transport",
        ));
    }
    Ok(())
}

fn capture_temporary_png(plan: &CommandPlan, path: &str) -> HandlerResult {
    let capture = run_command(plan).and_then(|()| {
        fs::read(path).map_err(|err| {
            AtspiError::unavailable(format!("failed to read screenshot file {path}: {err}"))
        })
    });
    let cleanup_error = match fs::remove_file(path) {
        Ok(()) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => Some(error),
    };
    match (capture, cleanup_error) {
        (Ok(bytes), None) => Ok(serde_json::json!({
                "base64": base64_encode(&bytes),
                "mime": "image/png",
                "bytes": bytes.len(),
                "backend": plan.program,
            })),
        (Ok(_), Some(error)) => Err(AtspiError::unavailable(format!(
            "screenshot succeeded but temporary file cleanup failed for {path}: {error}"
        ))),
        (Err(capture_error), None) => Err(capture_error),
        (Err(capture_error), Some(cleanup_error)) => Err(AtspiError::unavailable(format!(
            "screenshot failed ({capture_error:?}) and temporary file cleanup failed for {path}: {cleanup_error}"
        ))),
    }
}

fn display_server_from_env() -> DisplayServer {
    display_server_from_iter(env::vars())
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

fn screenshot_command_for(
    server: DisplayServer,
    path: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if exists("gnome-screenshot") {
        return Ok(CommandPlan {
            program: "gnome-screenshot".into(),
            args: vec!["-f".into(), path.into()],
        });
    }

    match server {
        DisplayServer::Wayland => wayland_screenshot_command(path, exists),
        DisplayServer::X11 => x11_screenshot_command(path, exists),
        DisplayServer::Headless => Err(AtspiError::unavailable(
            "no WAYLAND_DISPLAY or DISPLAY environment is available for screenshot capture",
        )),
    }
}

fn window_screenshot_command_for(
    server: DisplayServer,
    path: &str,
    window_id: &str,
    bounds: Option<&crate::tree::WindowBounds>,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if server == DisplayServer::X11 && exists("import") {
        return Ok(CommandPlan {
            program: "import".into(),
            args: vec!["-window".into(), window_id.into(), path.into()],
        });
    }
    if server == DisplayServer::Wayland {
        if let Some(bounds) = bounds {
            if exists("grim") {
                return Ok(CommandPlan {
                    program: "grim".into(),
                    args: vec![
                        "-g".into(),
                        format!(
                            "{},{} {}x{}",
                            bounds.x, bounds.y, bounds.width, bounds.height
                        ),
                        path.into(),
                    ],
                });
            }
        }
    }

    Err(AtspiError::unavailable(
        "no screenshot backend can capture the requested window without exposing the full desktop",
    ))
}

fn region_screenshot_command_for(
    server: DisplayServer,
    path: &str,
    bounds: &ElementBounds,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    match server {
        DisplayServer::X11 => x11_region_screenshot_command(path, bounds, exists),
        DisplayServer::Wayland => wayland_region_screenshot_command(path, bounds, exists),
        DisplayServer::Headless => Err(AtspiError::unavailable(
            "no WAYLAND_DISPLAY or DISPLAY environment is available for region screenshot capture",
        )),
    }
}

fn wayland_screenshot_command(
    path: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if exists("grim") {
        return Ok(CommandPlan {
            program: "grim".into(),
            args: vec![path.into()],
        });
    }
    Err(AtspiError::unavailable(
        "gnome-screenshot or grim is required for AT-SPI Wayland screenshot capture",
    ))
}

fn x11_screenshot_command(
    path: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if exists("import") {
        return Ok(CommandPlan {
            program: "import".into(),
            args: vec!["-window".into(), "root".into(), path.into()],
        });
    }
    Err(AtspiError::unavailable(
        "gnome-screenshot or ImageMagick import is required for AT-SPI X11 screenshot capture",
    ))
}

fn x11_region_screenshot_command(
    path: &str,
    bounds: &ElementBounds,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if exists("import") {
        return Ok(CommandPlan {
            program: "import".into(),
            args: vec![
                "-window".into(),
                "root".into(),
                "-crop".into(),
                format!(
                    "{}x{}+{}+{}",
                    bounds.width, bounds.height, bounds.x, bounds.y
                ),
                path.into(),
            ],
        });
    }
    Err(AtspiError::unavailable(
        "ImageMagick import is required for AT-SPI X11 region screenshot capture",
    ))
}

fn wayland_region_screenshot_command(
    path: &str,
    bounds: &ElementBounds,
    exists: impl Fn(&str) -> bool,
) -> Result<CommandPlan, AtspiError> {
    if exists("grim") {
        return Ok(CommandPlan {
            program: "grim".into(),
            args: vec![
                "-g".into(),
                format!(
                    "{},{} {}x{}",
                    bounds.x, bounds.y, bounds.width, bounds.height
                ),
                path.into(),
            ],
        });
    }
    Err(AtspiError::unavailable(
        "grim is required for AT-SPI Wayland region screenshot capture",
    ))
}

fn temporary_screenshot_path() -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    env::temp_dir().join(format!(
        "unicli-atspi-screenshot-{}-{now}.png",
        std::process::id()
    ))
}

fn run_command(plan: &CommandPlan) -> Result<(), AtspiError> {
    let status = Command::new(&plan.program)
        .args(&plan.args)
        .status()
        .map_err(|err| {
            AtspiError::unavailable(format!(
                "failed to run screenshot helper {}: {err}",
                plan.program
            ))
        })?;
    if status.success() {
        return Ok(());
    }
    Err(AtspiError::unavailable(format!(
        "screenshot helper {} exited with status {status}",
        plan.program
    )))
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

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = (u32::from(b0) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        out.push(TABLE[((n >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_window_honors_string_and_numeric_x11_id_and_rejects_ambiguity() {
        let windows = [
            WindowRecord {
                id: "0x03a00007".into(),
                pid: 1234,
                title: "Calculator One".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                states: vec![],
                children: vec![],
            },
            WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Calculator Two".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                states: vec![],
                children: vec![],
            },
        ];

        let selected =
            resolve_requested_window(&windows, &serde_json::json!({ "windowId": "0x03a00008" }))
                .expect("exact X11 window target");
        assert_eq!(selected.id, "0x03a00008");
        let numeric =
            resolve_requested_window(&windows, &serde_json::json!({ "windowId": 0x03a00008 }))
                .expect("numeric X11 id resolves to the same native window");
        assert_eq!(numeric.id, "0x03a00008");
        let ambiguous =
            resolve_requested_window(&windows, &serde_json::json!({ "app": "Calculator" }))
                .expect_err("a broad app query must not silently select a window");
        assert!(format!("{ambiguous:?}").contains("desktop-atspi.target_ambiguous"));
    }

    #[test]
    fn wayland_screenshot_uses_gnome_screenshot_when_available() {
        let plan = screenshot_command_for(DisplayServer::Wayland, "/tmp/shot.png", |program| {
            program == "gnome-screenshot"
        })
        .expect("wayland screenshot plan");

        assert_eq!(
            plan,
            CommandPlan {
                program: "gnome-screenshot".into(),
                args: vec!["-f".into(), "/tmp/shot.png".into()],
            },
        );
    }

    #[test]
    fn x11_screenshot_falls_back_to_import_when_gnome_screenshot_is_missing() {
        let plan = screenshot_command_for(DisplayServer::X11, "/tmp/shot.png", |program| {
            program == "import"
        })
        .expect("x11 screenshot plan");

        assert_eq!(
            plan,
            CommandPlan {
                program: "import".into(),
                args: vec!["-window".into(), "root".into(), "/tmp/shot.png".into()],
            },
        );
    }

    #[test]
    fn x11_window_screenshot_prefers_import_with_window_id() {
        let plan = window_screenshot_command_for(
            DisplayServer::X11,
            "/tmp/shot.png",
            "0x03a00008",
            None,
            |program| program == "gnome-screenshot" || program == "import",
        )
        .expect("x11 targeted screenshot plan");

        assert_eq!(
            plan,
            CommandPlan {
                program: "import".into(),
                args: vec![
                    "-window".into(),
                    "0x03a00008".into(),
                    "/tmp/shot.png".into()
                ],
            },
        );
    }

    #[test]
    fn wayland_window_screenshot_uses_grim_geometry_when_bounds_are_known() {
        let bounds = crate::tree::WindowBounds {
            x: 10,
            y: 20,
            width: 640,
            height: 480,
        };
        let plan = window_screenshot_command_for(
            DisplayServer::Wayland,
            "/tmp/shot.png",
            "0x03a00008",
            Some(&bounds),
            |program| program == "grim",
        )
        .expect("wayland targeted screenshot plan");

        assert_eq!(
            plan,
            CommandPlan {
                program: "grim".into(),
                args: vec!["-g".into(), "10,20 640x480".into(), "/tmp/shot.png".into()],
            },
        );
    }

    #[test]
    fn x11_region_screenshot_uses_import_root_crop() {
        let bounds = crate::tree::ElementBounds {
            x: 20,
            y: 30,
            width: 40,
            height: 50,
        };
        let plan = region_screenshot_command_for(
            DisplayServer::X11,
            "/tmp/element.png",
            &bounds,
            |program| program == "import",
        )
        .expect("x11 region screenshot plan");

        assert_eq!(
            plan,
            CommandPlan {
                program: "import".into(),
                args: vec![
                    "-window".into(),
                    "root".into(),
                    "-crop".into(),
                    "40x50+20+30".into(),
                    "/tmp/element.png".into(),
                ],
            },
        );
    }

    #[test]
    fn wayland_region_screenshot_uses_grim_geometry() {
        let bounds = crate::tree::ElementBounds {
            x: 20,
            y: 30,
            width: 40,
            height: 50,
        };
        let plan = region_screenshot_command_for(
            DisplayServer::Wayland,
            "/tmp/element.png",
            &bounds,
            |program| program == "grim",
        )
        .expect("wayland region screenshot plan");

        assert_eq!(
            plan,
            CommandPlan {
                program: "grim".into(),
                args: vec!["-g".into(), "20,30 40x50".into(), "/tmp/element.png".into()],
            },
        );
    }

    #[test]
    fn screenshot_response_includes_target_window_metadata() {
        let response = screenshot_response_for_window(
            &crate::tree::WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Terminal Settings".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                states: vec![],
                children: vec![],
            },
            "desktop-atspi:window-0x03a00008:Window[0]",
            serde_json::json!({
                "path": "/tmp/shot.png",
                "mime": "image/png",
                "backend": "gnome-screenshot",
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "captured": true,
                "via": "top_level_window_screenshot_helper",
                "stable": "desktop-atspi:window-0x03a00008:Window[0]",
                "id": "0x03a00008",
                "windowId": "0x03a00008",
                "pid": 1234,
                "title": "Terminal Settings",
                "screenshot": {
                    "path": "/tmp/shot.png",
                    "mime": "image/png",
                    "backend": "gnome-screenshot",
                },
            }),
        );
    }

    #[test]
    fn screenshot_response_includes_descendant_target_metadata() {
        let response = screenshot_response_for_descendant(
            &crate::tree::WindowRecord {
                id: "0x03a00008".into(),
                pid: 1234,
                title: "Calculator".into(),
                desktop: "0".into(),
                host: "host".into(),
                bounds: None,
                states: vec![],
                children: vec![],
            },
            &crate::tree::ElementRecord {
                role: "push_button".into(),
                name: "Seven".into(),
                value: None,
                bounds: Some(crate::tree::ElementBounds {
                    x: 20,
                    y: 30,
                    width: 40,
                    height: 50,
                }),
                states: vec!["enabled".into()],
                children: vec![],
            },
            "desktop-atspi:window-0x03a00008:Window[0]/push_button[1]",
            "Window[0]/push_button[1]",
            serde_json::json!({
                "path": "/tmp/element.png",
                "mime": "image/png",
                "backend": "grim",
                "scope": "region",
            }),
        );

        assert_eq!(
            response,
            serde_json::json!({
                "captured": true,
                "via": "descendant_bounds_screenshot_helper",
                "stable": "desktop-atspi:window-0x03a00008:Window[0]/push_button[1]",
                "id": "0x03a00008",
                "windowId": "0x03a00008",
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
                "screenshot": {
                    "path": "/tmp/element.png",
                    "mime": "image/png",
                    "backend": "grim",
                    "scope": "region",
                },
            }),
        );
    }
}
