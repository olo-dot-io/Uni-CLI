use std::io::{self, BufRead, BufWriter, Write};

use anyhow::Result;
use clap::Parser;
use serde_json::json;
use tracing::{debug, error};
use unicli_shared::{SidecarRequest, SidecarResponse, PROTOCOL_VERSION};

use crate::errors::IntoSidecarResponse;

mod errors;
mod input;
mod invoke;
mod refs;
mod screenshot;
mod tree;

#[derive(Debug, Parser)]
#[command(name = "unicli-atspi")]
#[command(about = "Uni-CLI Linux AT-SPI sidecar")]
struct Args {
    #[arg(long)]
    version_probe: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();
    init_tracing();

    if args.version_probe {
        println!(
            "{}",
            serde_json::to_string(&SidecarResponse::ok(
                0,
                "version_probe",
                json!({
                    "protocol": PROTOCOL_VERSION,
                    "transport": "desktop-atspi"
                }),
            ))?
        );
        return Ok(());
    }

    serve_stdio()
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "unicli_atspi=info".into());
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(io::stderr)
        .try_init();
}

fn serve_stdio() -> Result<()> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());
    let mut state = tree::State::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(err) => {
                error!("stdin read error: {err}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<SidecarRequest>(&line) {
            Ok(request) => dispatch(&mut state, request),
            Err(err) => SidecarResponse::error(
                0,
                "<parse>",
                "desktop-atspi",
                format!("invalid sidecar request: {err}"),
                "send one JSON request per line with id, kind, and params",
                65,
            ),
        };
        writeln!(out, "{}", serde_json::to_string(&response)?)?;
        out.flush()?;
    }

    Ok(())
}

fn dispatch(state: &mut tree::State, request: SidecarRequest) -> SidecarResponse {
    debug!(?request, "dispatch");
    let id = request.id;
    let kind = request.kind.clone();
    match kind.as_str() {
        "ping" => SidecarResponse::ok(
            id,
            kind,
            json!({
                "pong": true,
                "protocol": PROTOCOL_VERSION,
                "transport": "desktop-atspi"
            }),
        ),
        "atspi_apps" => tree::handle_apps(state, &request).into_response(id, kind),
        "atspi_windows" => tree::handle_windows(state, &request).into_response(id, kind),
        "atspi_snapshot" => tree::handle_snapshot(state, &request).into_response(id, kind),
        "atspi_find" => tree::handle_find(state, &request).into_response(id, kind),
        "atspi_wait" => tree::handle_wait(state, &request).into_response(id, kind),
        "atspi_observe" => tree::handle_observe(state, &request).into_response(id, kind),
        "atspi_assert" => tree::handle_assert(state, &request).into_response(id, kind),
        "atspi_invoke" => invoke::handle_invoke(state, &request).into_response(id, kind),
        "atspi_set_value" => invoke::handle_set_value(state, &request).into_response(id, kind),
        "atspi_focus" => invoke::handle_focus(state, &request).into_response(id, kind),
        "launch_app" => invoke::handle_launch_app(state, &request).into_response(id, kind),
        "atspi_press" => input::handle_press(&request).into_response(id, kind),
        "atspi_scroll" => input::handle_scroll(state, &request).into_response(id, kind),
        "atspi_screenshot" => screenshot::handle(state, &request).into_response(id, kind),
        other => SidecarResponse::error(
            id,
            other,
            "desktop-atspi",
            format!("unknown AT-SPI sidecar kind {other}"),
            "use one of the atspi_* methods advertised by the desktop-atspi transport",
            64,
        ),
    }
}
