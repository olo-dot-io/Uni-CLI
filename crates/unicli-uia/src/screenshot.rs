use serde_json::Value;
use unicli_shared::SidecarRequest;

use crate::errors::{backend_unavailable, HandlerResult, UiaError};
use crate::tree::{
    enumerate_top_level_windows, resolve_descendant_element_ref, resolve_top_level_window_ref,
    ElementBounds, ElementRecord, State, WindowRecord,
};

#[cfg(any(target_os = "windows", test))]
const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

pub fn handle(_state: &mut State, request: &SidecarRequest) -> HandlerResult {
    if !cfg!(target_os = "windows") {
        return Err(backend_unavailable());
    }

    let windows = enumerate_top_level_windows()?;
    if let Some(stable) = read_stable_ref(&request.params) {
        if let Some((window, element, path)) = resolve_descendant_element_ref(&windows, stable) {
            let bounds = require_descendant_bounds(element, stable)?;
            let capture = capture_descendant_png(window, bounds)?;
            return Ok(screenshot_response_for_descendant(
                window, element, stable, &path, capture,
            ));
        }
    }
    let window = resolve_requested_window(&windows, &request.params)?;
    let capture = capture_window_png(window)?;
    Ok(serde_json::json!({
        "base64": base64_encode(&capture.bytes),
        "mime": "image/png",
        "width": capture.width,
        "height": capture.height,
        "stable": stable_ref_for_window(&windows, window),
        "hwnd": window.hwnd,
        "pid": window.pid,
        "title": window.title,
    }))
}

fn read_stable_ref(params: &Value) -> Option<&str> {
    params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("desktop-uia:"))
}

fn resolve_requested_window<'a>(
    windows: &'a [WindowRecord],
    params: &Value,
) -> Result<&'a WindowRecord, UiaError> {
    if let Some(stable) = params
        .get("stable")
        .or_else(|| params.get("ref"))
        .and_then(Value::as_str)
    {
        return resolve_top_level_window_ref(windows, stable)
            .ok_or_else(|| UiaError::no_element(stable.to_string()));
    }

    windows
        .iter()
        .find(|window| window_matches_params(window, params))
        .ok_or_else(|| UiaError::no_element("top-level window screenshot query"))
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

fn stable_ref_for_window(windows: &[WindowRecord], target: &WindowRecord) -> String {
    let index = windows
        .iter()
        .filter(|window| window.pid == target.pid)
        .position(|window| window.hwnd == target.hwnd)
        .unwrap_or(0);
    format!("desktop-uia:pid-{}:Window[{index}]", target.pid)
}

fn screenshot_response_for_descendant(
    window: &WindowRecord,
    element: &ElementRecord,
    stable: &str,
    path: &str,
    capture: CapturedPng,
) -> serde_json::Value {
    let mut target = descendant_target_node(element, path);
    if let Some(bounds) = &element.bounds {
        target["bounds"] = bounds_node(bounds);
    }
    serde_json::json!({
        "captured": true,
        "via": "descendant_bounds_screenshot",
        "base64": base64_encode(&capture.bytes),
        "mime": "image/png",
        "width": capture.width,
        "height": capture.height,
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

struct CapturedPng {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

#[cfg(target_os = "windows")]
fn capture_window_png(window: &WindowRecord) -> Result<CapturedPng, UiaError> {
    let hwnd = parse_hwnd(&window.hwnd)?;
    captured_png_from_bgra(capture_window_bgra(hwnd)?)
}

#[cfg(not(target_os = "windows"))]
fn capture_window_png(_window: &WindowRecord) -> Result<CapturedPng, UiaError> {
    Err(backend_unavailable())
}

#[cfg(target_os = "windows")]
fn capture_descendant_png(
    window: &WindowRecord,
    bounds: &ElementBounds,
) -> Result<CapturedPng, UiaError> {
    let hwnd = parse_hwnd(&window.hwnd)?;
    captured_png_from_bgra(crop_bgra_to_bounds(&capture_window_bgra(hwnd)?, bounds)?)
}

#[cfg(not(target_os = "windows"))]
fn capture_descendant_png(
    _window: &WindowRecord,
    _bounds: &ElementBounds,
) -> Result<CapturedPng, UiaError> {
    Err(backend_unavailable())
}

#[cfg(target_os = "windows")]
fn captured_png_from_bgra(bitmap: BgraImage) -> Result<CapturedPng, UiaError> {
    let bytes = png_bytes_from_bgra(bitmap.width, bitmap.height, &bitmap.bgra)?;
    Ok(CapturedPng {
        bytes,
        width: bitmap.width,
        height: bitmap.height,
    })
}

#[cfg(any(target_os = "windows", test))]
fn crop_bgra_to_bounds(image: &BgraImage, bounds: &ElementBounds) -> Result<BgraImage, UiaError> {
    if bounds.width == 0 || bounds.height == 0 {
        return Err(UiaError::invalid_input(
            "descendant screenshot bounds are empty",
        ));
    }
    let left = bounds.x - image.origin_x;
    let top = bounds.y - image.origin_y;
    if left < 0 || top < 0 {
        return Err(UiaError::invalid_input(
            "descendant screenshot bounds start outside captured window",
        ));
    }
    let left = left as u32;
    let top = top as u32;
    if left + bounds.width > image.width || top + bounds.height > image.height {
        return Err(UiaError::invalid_input(
            "descendant screenshot bounds exceed captured window",
        ));
    }

    let source_stride = image.width as usize * 4;
    let row_bytes = bounds.width as usize * 4;
    let mut bgra = Vec::with_capacity(row_bytes * bounds.height as usize);
    for row in 0..bounds.height {
        let start = ((top + row) as usize * source_stride) + (left as usize * 4);
        bgra.extend_from_slice(&image.bgra[start..start + row_bytes]);
    }
    Ok(BgraImage {
        bgra,
        width: bounds.width,
        height: bounds.height,
        origin_x: bounds.x,
        origin_y: bounds.y,
    })
}

#[cfg(any(target_os = "windows", test))]
fn png_bytes_from_bgra(width: u32, height: u32, bgra: &[u8]) -> Result<Vec<u8>, UiaError> {
    let expected_len = width as usize * height as usize * 4;
    if bgra.len() != expected_len {
        return Err(UiaError::invalid_input(format!(
            "BGRA buffer length {} does not match {width}x{height}",
            bgra.len()
        )));
    }

    let stride = width as usize * 4;
    let mut raw = Vec::with_capacity((stride + 1) * height as usize);
    for row in bgra.chunks_exact(stride) {
        raw.push(0);
        for pixel in row.chunks_exact(4) {
            raw.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
        }
    }

    let mut png = Vec::new();
    png.extend_from_slice(PNG_SIGNATURE);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    append_png_chunk(&mut png, b"IHDR", &ihdr);
    append_png_chunk(&mut png, b"IDAT", &zlib_uncompressed(&raw));
    append_png_chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

#[cfg(any(target_os = "windows", test))]
fn append_png_chunk(png: &mut Vec<u8>, name: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(name);
    png.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(name.len() + data.len());
    crc_input.extend_from_slice(name);
    crc_input.extend_from_slice(data);
    png.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

#[cfg(any(target_os = "windows", test))]
fn zlib_uncompressed(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() + 6 + (data.len() / 65_535) * 5);
    out.extend_from_slice(&[0x78, 0x01]);
    for (index, chunk) in data.chunks(65_535).enumerate() {
        let final_block = (index + 1) * 65_535 >= data.len();
        out.push(if final_block { 0x01 } else { 0x00 });
        let len = chunk.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(chunk);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

#[cfg(any(target_os = "windows", test))]
fn adler32(data: &[u8]) -> u32 {
    const MOD: u32 = 65_521;
    let mut a = 1_u32;
    let mut b = 0_u32;
    for byte in data {
        a = (a + u32::from(*byte)) % MOD;
        b = (b + a) % MOD;
    }
    (b << 16) | a
}

#[cfg(any(target_os = "windows", test))]
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0_u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
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

#[cfg(any(target_os = "windows", test))]
struct BgraImage {
    bgra: Vec<u8>,
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
}

#[cfg(target_os = "windows")]
fn capture_window_bgra(hwnd: isize) -> Result<BgraImage, UiaError> {
    let mut rect = win32::Rect::default();
    let ok = unsafe { win32::GetWindowRect(hwnd, &mut rect) };
    if ok == 0 {
        return Err(UiaError::permission(format!(
            "GetWindowRect failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    let width = (rect.right - rect.left).max(0) as u32;
    let height = (rect.bottom - rect.top).max(0) as u32;
    if width == 0 || height == 0 {
        return Err(UiaError::invalid_input("target window has empty bounds"));
    }

    let window_dc = unsafe { win32::GetWindowDC(hwnd) };
    if window_dc == 0 {
        return Err(UiaError::permission(format!(
            "GetWindowDC failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    let result = capture_from_window_dc(window_dc, width, height, rect.left, rect.top);
    unsafe {
        win32::ReleaseDC(hwnd, window_dc);
    }
    result
}

#[cfg(target_os = "windows")]
fn capture_from_window_dc(
    window_dc: isize,
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
) -> Result<BgraImage, UiaError> {
    let memory_dc = unsafe { win32::CreateCompatibleDC(window_dc) };
    if memory_dc == 0 {
        return Err(UiaError::permission(format!(
            "CreateCompatibleDC failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    let bitmap = unsafe { win32::CreateCompatibleBitmap(window_dc, width as i32, height as i32) };
    if bitmap == 0 {
        unsafe {
            win32::DeleteDC(memory_dc);
        }
        return Err(UiaError::permission(format!(
            "CreateCompatibleBitmap failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    let old_object = unsafe { win32::SelectObject(memory_dc, bitmap) };
    let copied = unsafe {
        win32::BitBlt(
            memory_dc,
            0,
            0,
            width as i32,
            height as i32,
            window_dc,
            0,
            0,
            win32::SRCCOPY,
        )
    };
    let mut bgra = vec![0_u8; width as usize * height as usize * 4];
    let mut info = win32::BitmapInfo::top_down_bgra(width, height);
    let scan_lines = if copied != 0 {
        unsafe {
            win32::GetDIBits(
                memory_dc,
                bitmap,
                0,
                height,
                bgra.as_mut_ptr().cast(),
                &mut info,
                win32::DIB_RGB_COLORS,
            )
        }
    } else {
        0
    };

    unsafe {
        if old_object != 0 {
            win32::SelectObject(memory_dc, old_object);
        }
        win32::DeleteObject(bitmap);
        win32::DeleteDC(memory_dc);
    }

    if copied == 0 {
        return Err(UiaError::permission(format!(
            "BitBlt failed: {}",
            std::io::Error::last_os_error()
        )));
    }
    if scan_lines == 0 {
        return Err(UiaError::permission(format!(
            "GetDIBits failed: {}",
            std::io::Error::last_os_error()
        )));
    }

    Ok(BgraImage {
        bgra,
        width,
        height,
        origin_x,
        origin_y,
    })
}

#[cfg(target_os = "windows")]
fn parse_hwnd(value: &str) -> Result<isize, UiaError> {
    let raw = value.strip_prefix("0x").unwrap_or(value);
    isize::from_str_radix(raw, 16)
        .map_err(|_| UiaError::invalid_input(format!("invalid window handle {value}")))
}

#[cfg(target_os = "windows")]
mod win32 {
    pub const SRCCOPY: u32 = 0x00cc_0020;
    pub const DIB_RGB_COLORS: u32 = 0;
    const BI_RGB: u32 = 0;

    #[derive(Default)]
    #[repr(C)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    pub struct BitmapInfo {
        pub header: BitmapInfoHeader,
        pub colors: [RgbQuad; 1],
    }

    impl BitmapInfo {
        pub fn top_down_bgra(width: u32, height: u32) -> Self {
            Self {
                header: BitmapInfoHeader {
                    size: std::mem::size_of::<BitmapInfoHeader>() as u32,
                    width: width as i32,
                    height: -(height as i32),
                    planes: 1,
                    bit_count: 32,
                    compression: BI_RGB,
                    size_image: width * height * 4,
                    x_pels_per_meter: 0,
                    y_pels_per_meter: 0,
                    clr_used: 0,
                    clr_important: 0,
                },
                colors: [RgbQuad::default()],
            }
        }
    }

    #[repr(C)]
    pub struct BitmapInfoHeader {
        pub size: u32,
        pub width: i32,
        pub height: i32,
        pub planes: u16,
        pub bit_count: u16,
        pub compression: u32,
        pub size_image: u32,
        pub x_pels_per_meter: i32,
        pub y_pels_per_meter: i32,
        pub clr_used: u32,
        pub clr_important: u32,
    }

    #[derive(Clone, Copy, Default)]
    #[repr(C)]
    pub struct RgbQuad {
        pub blue: u8,
        pub green: u8,
        pub red: u8,
        pub reserved: u8,
    }

    #[link(name = "user32")]
    extern "system" {
        pub fn GetWindowRect(hwnd: isize, rect: *mut Rect) -> i32;
        pub fn GetWindowDC(hwnd: isize) -> isize;
        pub fn ReleaseDC(hwnd: isize, dc: isize) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        pub fn CreateCompatibleDC(dc: isize) -> isize;
        pub fn CreateCompatibleBitmap(dc: isize, width: i32, height: i32) -> isize;
        pub fn SelectObject(dc: isize, object: isize) -> isize;
        pub fn BitBlt(
            dc: isize,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            source_dc: isize,
            source_x: i32,
            source_y: i32,
            raster_op: u32,
        ) -> i32;
        pub fn GetDIBits(
            dc: isize,
            bitmap: isize,
            start_scan: u32,
            scan_lines: u32,
            bits: *mut std::ffi::c_void,
            info: *mut BitmapInfo,
            usage: u32,
        ) -> i32;
        pub fn DeleteObject(object: isize) -> i32;
        pub fn DeleteDC(dc: isize) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tree::{ElementBounds, ElementRecord, WindowRecord};

    #[test]
    fn png_encoder_wraps_bgra_pixels_as_rgba_png() {
        let png = png_bytes_from_bgra(1, 1, &[0x33, 0x22, 0x11, 0xff]).expect("png");

        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[16..20], 1_u32.to_be_bytes());
        assert_eq!(&png[20..24], 1_u32.to_be_bytes());
        assert_eq!(base64_encode(&png[..4]), "iVBORw==");
    }

    #[test]
    fn crops_bgra_to_descendant_bounds_relative_to_window_origin() {
        let image = BgraImage {
            bgra: vec![
                0, 0, 0, 255, 1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255,
                6, 0, 0, 255, 7, 0, 0, 255, 8, 0, 0, 255,
            ],
            width: 3,
            height: 3,
            origin_x: 10,
            origin_y: 20,
        };

        let cropped = crop_bgra_to_bounds(
            &image,
            &ElementBounds {
                x: 11,
                y: 21,
                width: 2,
                height: 2,
            },
        )
        .expect("cropped descendant image");

        assert_eq!(cropped.width, 2);
        assert_eq!(cropped.height, 2);
        assert_eq!(
            cropped.bgra,
            vec![4, 0, 0, 255, 5, 0, 0, 255, 7, 0, 0, 255, 8, 0, 0, 255],
        );
    }

    #[test]
    fn screenshot_response_includes_descendant_target_metadata() {
        let response = screenshot_response_for_descendant(
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
            CapturedPng {
                bytes: vec![137, 80, 78, 71],
                width: 40,
                height: 50,
            },
        );

        assert_eq!(
            response,
            serde_json::json!({
                "captured": true,
                "via": "descendant_bounds_screenshot",
                "base64": "iVBORw==",
                "mime": "image/png",
                "width": 40,
                "height": 50,
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
}
