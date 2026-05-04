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
    ElementBounds, ElementRecord, State, WindowRecord,
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

    capture_screenshot(&request.params)
}

fn capture_screenshot(params: &Value) -> HandlerResult {
    let requested_path = read_path(params);
    let path = requested_path
        .clone()
        .unwrap_or_else(|| temporary_screenshot_path().to_string_lossy().into_owned());
    let plan = screenshot_command_for(display_server_from_env(), &path, command_exists)?;
    run_command(&plan)?;

    let response = if requested_path.is_some() {
        serde_json::json!({
            "path": path,
            "mime": "image/png",
            "backend": plan.program,
        })
    } else {
        let bytes = fs::read(&path).map_err(|err| {
            AtspiError::unavailable(format!("failed to read screenshot file {path}: {err}"))
        })?;
        let _ = fs::remove_file(&path);
        serde_json::json!({
            "base64": base64_encode(&bytes),
            "mime": "image/png",
            "bytes": bytes.len(),
            "backend": plan.program,
        })
    };

    Ok(response)
}

fn capture_window_screenshot(params: &Value, window: &WindowRecord) -> HandlerResult {
    let requested_path = read_path(params);
    let path = requested_path
        .clone()
        .unwrap_or_else(|| temporary_screenshot_path().to_string_lossy().into_owned());
    let plan = window_screenshot_command_for(
        display_server_from_env(),
        &path,
        &window.id,
        window.bounds.as_ref(),
        command_exists,
    )?;

    if !plan_targets_window(&plan, &window.id) {
        crate::invoke::focus_top_level_window(window)?;
    }

    run_command(&plan)?;

    let mut response = if requested_path.is_some() {
        serde_json::json!({
            "path": path,
            "mime": "image/png",
            "backend": plan.program,
        })
    } else {
        let bytes = fs::read(&path).map_err(|err| {
            AtspiError::unavailable(format!("failed to read screenshot file {path}: {err}"))
        })?;
        let _ = fs::remove_file(&path);
        serde_json::json!({
            "base64": base64_encode(&bytes),
            "mime": "image/png",
            "bytes": bytes.len(),
            "backend": plan.program,
        })
    };

    if plan_targets_window(&plan, &window.id) {
        response["scope"] = serde_json::json!("window");
        response["windowId"] = serde_json::json!(window.id);
    } else {
        response["scope"] = serde_json::json!("screen_after_focus");
    }

    Ok(response)
}

fn capture_region_screenshot(params: &Value, bounds: &ElementBounds) -> HandlerResult {
    let requested_path = read_path(params);
    let path = requested_path
        .clone()
        .unwrap_or_else(|| temporary_screenshot_path().to_string_lossy().into_owned());
    let plan =
        region_screenshot_command_for(display_server_from_env(), &path, bounds, command_exists)?;

    run_command(&plan)?;

    let mut response = if requested_path.is_some() {
        serde_json::json!({
            "path": path,
            "mime": "image/png",
            "backend": plan.program,
        })
    } else {
        let bytes = fs::read(&path).map_err(|err| {
            AtspiError::unavailable(format!("failed to read screenshot file {path}: {err}"))
        })?;
        let _ = fs::remove_file(&path);
        serde_json::json!({
            "base64": base64_encode(&bytes),
            "mime": "image/png",
            "bytes": bytes.len(),
            "backend": plan.program,
        })
    };
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
    serde_json::json!({
        "captured": true,
        "via": "top_level_window_screenshot_helper",
        "stable": stable,
        "id": window.id,
        "pid": window.pid,
        "title": window.title,
        "screenshot": screenshot,
    })
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

fn read_path(params: &Value) -> Option<String> {
    params
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(String::from)
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

    screenshot_command_for(server, path, exists)
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

fn plan_targets_window(plan: &CommandPlan, window_id: &str) -> bool {
    (plan.program == "import"
        && plan.args.first().map(String::as_str) == Some("-window")
        && plan.args.get(1).map(String::as_str) == Some(window_id))
        || (plan.program == "grim" && plan.args.first().map(String::as_str) == Some("-g"))
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
        .map(|duration| duration.as_millis())
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
                children: vec![],
            },
            "desktop-atspi:pid-1234:Window[1]",
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
                "stable": "desktop-atspi:pid-1234:Window[1]",
                "id": "0x03a00008",
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
            "desktop-atspi:pid-1234:Window[0]/push_button[1]",
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
