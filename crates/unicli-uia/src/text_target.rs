//! Retained focused text targets live on the sidecar's single COM apartment.

#[cfg(target_os = "windows")]
mod native {
    use crate::{
        errors::{HandlerResult, UiaError},
        input,
    };
    use serde::Serialize;
    use serde_json::{json, Value};
    use std::{
        collections::BTreeMap,
        ffi::c_void,
        io,
        ptr::null_mut,
        thread::sleep,
        time::{Duration, Instant},
    };
    use unicli_shared::SidecarRequest;
    use windows::{
        core::{Interface, BSTR, PWSTR},
        Win32::{
            Foundation::{CloseHandle, HWND, RECT},
            System::{
                Com::{
                    CoCreateGuid, CoCreateInstance, CoInitializeEx, CoUninitialize,
                    CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
                },
                SystemInformation::GetTickCount64,
                Threading::{
                    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                    PROCESS_QUERY_LIMITED_INFORMATION,
                },
            },
            UI::{
                Accessibility::*,
                HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
                WindowsAndMessaging::{
                    GetAncestor, GetForegroundWindow, GetWindowRect, GetWindowTextW,
                    GetWindowThreadProcessId, IsWindow, IsWindowVisible, GA_ROOT,
                },
            },
        },
    };

    const MAX_TEXT_UNITS: i32 = 262_144;
    const MAX_LEASES: usize = 128;

    #[derive(Clone, Serialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct TextSnapshot {
        value: String,
        selection_start: usize,
        selection_length: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        composition_length: Option<usize>,
    }

    #[derive(Clone, Serialize, PartialEq)]
    struct WindowFrame {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct WindowInfo {
        hwnd: String,
        pid: u32,
        title: String,
        app_name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        frame: Option<WindowFrame>,
    }

    struct Lease {
        element: IUIAutomationElement,
        selection: Option<IUIAutomationTextRange>,
        identity_only: bool,
        follow_up_key_eligible: bool,
        hwnd: HWND,
        element_pid: i32,
        window: WindowInfo,
        snapshot: TextSnapshot,
        revision: u64,
    }

    struct Apartment {
        automation: Option<IUIAutomation>,
        generation: String,
        leases: BTreeMap<String, Lease>,
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            self.leases.clear();
            self.automation.take();
            unsafe {
                CoUninitialize();
            }
        }
    }

    #[derive(Default)]
    pub struct TextTargets {
        apartment: Option<Apartment>,
    }

    impl TextTargets {
        pub fn handle(
            &mut self,
            request: &SidecarRequest,
            acknowledge: &mut dyn FnMut() -> io::Result<()>,
        ) -> HandlerResult {
            if self.apartment.is_none() {
                self.apartment = Some(Apartment::new()?);
            }
            self.apartment
                .as_mut()
                .unwrap()
                .handle(request, acknowledge)
        }
    }

    impl Apartment {
        fn new() -> Result<Self, UiaError> {
            unsafe {
                CoInitializeEx(None, COINIT_MULTITHREADED)
                    .ok()
                    .map_err(native_error)?;
                let initialized = (|| {
                    let automation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
                        .map_err(native_error)?;
                    let generation = format!("{:?}", CoCreateGuid().map_err(native_error)?);
                    Ok(Self {
                        automation: Some(automation),
                        generation,
                        leases: BTreeMap::new(),
                    })
                })();
                if initialized.is_err() {
                    CoUninitialize();
                }
                initialized
            }
        }

        fn automation(&self) -> &IUIAutomation {
            self.automation.as_ref().unwrap()
        }

        fn handle(
            &mut self,
            request: &SidecarRequest,
            acknowledge: &mut dyn FnMut() -> io::Result<()>,
        ) -> HandlerResult {
            match request.kind.as_str() {
                "uia_text_capture" => self.capture(&request.params),
                "uia_text_context" => self.context(),
                "uia_text_visible" => self.visible(&request.params),
                "uia_text_validate" => self.validate(&request.params),
                "uia_text_recover" => self.recover(&request.params),
                "uia_text_paste" => self.paste(&request.params, acknowledge),
                "uia_text_replace" => self.replace(&request.params, acknowledge),
                "uia_text_key" => self.key(&request.params, acknowledge),
                "uia_text_release" => {
                    let id = lease_id(&request.params)?;
                    if request.params["lease"]["generation"].as_str() == Some(&self.generation) {
                        self.leases.remove(id);
                    }
                    Ok(json!({"status":"released"}))
                }
                _ => Err(UiaError::invalid_input(
                    "unknown retained text target operation",
                )),
            }
        }

        fn capture(&mut self, params: &Value) -> HandlerResult {
            if self.leases.len() >= MAX_LEASES {
                return Err(UiaError::unavailable(
                    "release an existing text target before capturing another",
                ));
            }
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.0.is_null() {
                    return Ok(rejected("no_foreground_window"));
                }
                let element = self
                    .automation()
                    .GetFocusedElement()
                    .map_err(native_error)?;
                let window = window_info(hwnd);
                let element_pid = element.CurrentProcessId().map_err(native_error)?;
                let retain_identity = match params.get("retainFocusIdentity") {
                    None => false,
                    Some(value) => value.as_bool().ok_or_else(|| {
                        UiaError::invalid_input("retainFocusIdentity must be boolean")
                    })?,
                };
                let (snapshot, selection, identity_only) = match read_snapshot(&element, true) {
                    Ok((snapshot, selection)) => (snapshot, Some(selection), false),
                    Err(reason)
                        if retain_identity
                            && identity_candidate(&element)
                            && identity_snapshot_unavailable(reason) =>
                    {
                        (
                            TextSnapshot {
                                value: String::new(),
                                selection_start: 0,
                                selection_length: 0,
                                composition_length: active_composition(&element),
                            },
                            None,
                            true,
                        )
                    }
                    Err(reason) => {
                        return Ok(json!({"status":"unavailable","reason":reason,"window":window}))
                    }
                };
                if snapshot.composition_length.is_some_and(|length| length > 0) {
                    return Ok(rejected("active_composition"));
                }
                if !self.focus_matches(hwnd, &element, element_pid, window.pid) {
                    return Ok(rejected("focus_changed"));
                }
                // UIA providers are out of process. A second observation rejects torn baselines.
                if !identity_only {
                    let (after, _) = match read_snapshot(&element, true) {
                        Ok(value) => value,
                        Err(reason) => return Ok(rejected(reason)),
                    };
                    if snapshot != after {
                        return Ok(rejected("text_changed"));
                    }
                }
                let id = snapshot_id()?;
                let lease = Lease {
                    element,
                    selection,
                    identity_only,
                    follow_up_key_eligible: false,
                    hwnd,
                    element_pid,
                    window,
                    snapshot,
                    revision: 0,
                };
                let result = self.snapshot_result(&id, &lease);
                self.leases.insert(id, lease);
                Ok(json!({"status":"ok","lease":result}))
            }
        }

        fn context(&self) -> HandlerResult {
            let observed = uptime_nanoseconds();
            unsafe {
                let hwnd = GetForegroundWindow();
                if hwnd.0.is_null() {
                    return Ok(rejected("no_foreground_window"));
                }
                let window = window_info(hwnd);
                let mut text = None;
                let mut text_status = "focused_element_unavailable";
                let mut coherent = true;
                if let Ok(element) = self.automation().GetFocusedElement() {
                    let pid = element.CurrentProcessId().map_err(native_error)?;
                    match read_snapshot(&element, false) {
                        Ok((snapshot, _)) => {
                            let writable = writable(&element);
                            let mut value = serde_json::to_value(&snapshot)
                                .map_err(|error| UiaError::unavailable(error.to_string()))?;
                            value["writable"] = json!(writable);
                            text = Some(value);
                            text_status = "ok";
                        }
                        Err(reason) => text_status = reason,
                    }
                    coherent = self.focus_matches(hwnd, &element, pid, window.pid);
                }
                coherent = coherent && GetForegroundWindow() == hwnd;
                if !coherent {
                    text = None;
                    text_status = "focus_changed";
                }
                let mut snapshot = json!({
                    "id": snapshot_id()?, "window": window,
                    "observedAtNanoseconds": observed,
                    "completedAtNanoseconds": uptime_nanoseconds(),
                    "coherence": if coherent { "stable" } else { "frontmost_changed" },
                    "textStatus": text_status,
                });
                if let Some(text) = text {
                    snapshot["text"] = text;
                }
                Ok(json!({"status":"ok", "snapshot":snapshot}))
            }
        }

        fn visible(&self, params: &Value) -> HandlerResult {
            let target = &params["target"];
            unsafe {
                let hwnd = match target.get("hwnd") {
                    None => GetForegroundWindow(),
                    Some(value) => {
                        let value = value
                            .as_str()
                            .and_then(|value| value.strip_prefix("0x"))
                            .and_then(|value| usize::from_str_radix(value, 16).ok())
                            .filter(|value| *value > 0)
                            .ok_or_else(|| {
                                UiaError::invalid_input("hwnd must be a nonzero hex string")
                            })?;
                        HWND(value as *mut c_void)
                    }
                };
                if !IsWindow(hwnd).as_bool() || !IsWindowVisible(hwnd).as_bool() {
                    return Ok(rejected("window_unavailable"));
                }
                let window = window_info(hwnd);
                if !target_matches(target, &window)? {
                    return Ok(rejected("window_changed"));
                }
                let root = self
                    .automation()
                    .ElementFromHandle(hwnd)
                    .map_err(native_error)?;
                let walker = self
                    .automation()
                    .ControlViewWalker()
                    .map_err(native_error)?;
                let mut pending = vec![root];
                let mut text = String::new();
                let mut visited = 0usize;
                let mut truncated = false;
                let mut text_full = false;
                while let Some(element) = pending.pop() {
                    visited += 1;
                    if element
                        .CurrentIsPassword()
                        .map(|v| v.as_bool())
                        .unwrap_or(true)
                        || element
                            .CurrentIsOffscreen()
                            .map(|v| v.as_bool())
                            .unwrap_or(true)
                    {
                        continue;
                    }
                    let mut handled_text = false;
                    if let Ok(pattern) =
                        element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                    {
                        if let Ok(ranges) = pattern.GetVisibleRanges() {
                            let count = ranges.Length().unwrap_or(0);
                            for index in 0..count.min(400) {
                                if let Ok(range) = ranges.GetElement(index) {
                                    if let Ok(value) = range.GetText(5001) {
                                        handled_text = true;
                                        if append_visible(&mut text, &value.to_string()) {
                                            truncated = true;
                                            text_full = true;
                                            break;
                                        }
                                    }
                                }
                            }
                            if count > 400 {
                                truncated = true;
                            }
                        }
                    }
                    if !handled_text {
                        if let Ok(name) = element.CurrentName() {
                            if append_visible(&mut text, &name.to_string()) {
                                truncated = true;
                                text_full = true;
                            }
                        }
                    }
                    if text_full || visited >= 400 {
                        truncated = true;
                        break;
                    }
                    if !handled_text {
                        if let Ok(mut child) = walker.GetFirstChildElement(&element) {
                            let mut children = Vec::new();
                            loop {
                                children.push(child.clone());
                                if pending.len() + children.len() + visited >= 400 {
                                    truncated = true;
                                    break;
                                }
                                let Ok(next) = walker.GetNextSiblingElement(&child) else {
                                    break;
                                };
                                child = next;
                            }
                            pending.extend(children.into_iter().rev());
                        }
                    }
                }
                let after = window_info(hwnd);
                if !IsWindow(hwnd).as_bool()
                    || !IsWindowVisible(hwnd).as_bool()
                    || after.pid != window.pid
                    || after.title != window.title
                    || after.frame != window.frame
                    || !target_matches(target, &after)?
                {
                    return Ok(rejected("window_changed"));
                }
                if text.is_empty() {
                    return Ok(rejected("visible_text_unavailable"));
                }
                Ok(json!({"status":"ok", "snapshot":{
                    "id":snapshot_id()?, "window":window, "text":text,
                    "truncated":truncated, "visitedNodeCount":visited,
                }}))
            }
        }

        fn snapshot_result(&self, id: &str, lease: &Lease) -> Value {
            let mut result = json!({"id":id,"generation":self.generation,"revision":lease.revision,"window":lease.window,
                "textSnapshot":if lease.identity_only { "identity_only" } else { "complete" },
                "followUpKeyEligible":lease.follow_up_key_eligible});
            if !lease.identity_only {
                result["text"] = json!(lease.snapshot);
            }
            result
        }

        fn focus_matches(
            &self,
            hwnd: HWND,
            element: &IUIAutomationElement,
            element_pid: i32,
            window_pid: u32,
        ) -> bool {
            unsafe {
                if !IsWindow(hwnd).as_bool() || GetForegroundWindow() != hwnd {
                    return false;
                }
                let mut current_window_pid = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut current_window_pid));
                if current_window_pid != window_pid
                    || element.CurrentProcessId().ok() != Some(element_pid)
                    || element.CurrentHasKeyboardFocus().map(|v| v.as_bool()).ok() != Some(true)
                {
                    return false;
                }
                let Ok(focused) = self.automation().GetFocusedElement() else {
                    return false;
                };
                if self
                    .automation()
                    .CompareElements(element, &focused)
                    .map(|v| v.as_bool())
                    .ok()
                    != Some(true)
                {
                    return false;
                }
                let Ok(walker) = self.automation().RawViewWalker() else {
                    return false;
                };
                let mut ancestor = focused;
                for _ in 0..64 {
                    if let Ok(native) = ancestor.CurrentNativeWindowHandle() {
                        if !native.0.is_null() {
                            return GetAncestor(native, GA_ROOT) == GetAncestor(hwnd, GA_ROOT);
                        }
                    }
                    let Ok(parent) = walker.GetParentElement(&ancestor) else {
                        return false;
                    };
                    ancestor = parent;
                }
                false
            }
        }

        fn validate_lease(&self, params: &Value, id: &str) -> Result<(), &'static str> {
            let Some(lease) = self.leases.get(id) else {
                return Err("stale_target");
            };
            if params["lease"]["generation"].as_str() != Some(&self.generation)
                || params["lease"]["revision"].as_u64() != Some(lease.revision)
            {
                return Err("stale_target");
            }
            if !self.focus_matches(
                lease.hwnd,
                &lease.element,
                lease.element_pid,
                lease.window.pid,
            ) {
                return Err("focus_changed");
            }
            if lease.identity_only {
                if !identity_candidate(&lease.element) {
                    return Err("target_unavailable");
                }
                if active_composition(&lease.element).is_some_and(|length| length > 0) {
                    return Err("active_composition");
                }
                return Ok(());
            }
            let (snapshot, selection) = read_snapshot(&lease.element, true)?;
            if snapshot.composition_length.is_some_and(|length| length > 0) {
                return Err("active_composition");
            }
            if snapshot != lease.snapshot {
                return Err("text_changed");
            }
            unsafe {
                if lease
                    .selection
                    .as_ref()
                    .ok_or("selection_unavailable")?
                    .Compare(&selection)
                    .map(|v| v.as_bool())
                    .ok()
                    != Some(true)
                {
                    return Err("selection_changed");
                }
            }
            if !self.focus_matches(
                lease.hwnd,
                &lease.element,
                lease.element_pid,
                lease.window.pid,
            ) {
                return Err("focus_changed");
            }
            Ok(())
        }

        fn validate(&mut self, params: &Value) -> HandlerResult {
            let id = lease_id(params)?;
            if let Err(reason) = self.validate_lease(params, id) {
                self.revoke_if_current(params, id);
                return Ok(rejected(reason));
            }
            Ok(json!({"status":"ok","lease":self.snapshot_result(id, &self.leases[id])}))
        }

        fn recover(&mut self, params: &Value) -> HandlerResult {
            let id = lease_id(params)?;
            if let Err(reason) = self.validate_lease(params, id) {
                self.revoke_if_current(params, id);
                return Ok(rejected(reason));
            }
            let text = params["text"]
                .as_str()
                .filter(|text| !text.is_empty())
                .ok_or_else(|| UiaError::invalid_input("recover requires inserted text"))?;
            let lease = &self.leases[id];
            if !lease.identity_only {
                return Ok(rejected("identity_lease_required"));
            }
            let (snapshot, selection) = match read_snapshot(&lease.element, true) {
                Ok(value) => value,
                Err(reason) => return Ok(rejected(reason)),
            };
            let value: Vec<u16> = snapshot.value.encode_utf16().collect();
            let inserted: Vec<u16> = text.encode_utf16().collect();
            let caret = snapshot.selection_start;
            if snapshot.selection_length != 0
                || snapshot.composition_length.is_some_and(|length| length > 0)
                || caret < inserted.len()
                || value.get(caret - inserted.len()..caret) != Some(inserted.as_slice())
                || !self.focus_matches(
                    lease.hwnd,
                    &lease.element,
                    lease.element_pid,
                    lease.window.pid,
                )
            {
                return Ok(rejected("readback_mismatch"));
            }
            let mut lease = self.leases.remove(id).unwrap();
            lease.snapshot = snapshot;
            lease.selection = Some(selection);
            lease.identity_only = false;
            lease.follow_up_key_eligible = true;
            lease.revision += 1;
            let result = self.snapshot_result(id, &lease);
            self.leases.insert(id.to_string(), lease);
            Ok(json!({"status":"ok","lease":result}))
        }

        fn revoke_if_current(&mut self, params: &Value, id: &str) {
            if params["lease"]["generation"].as_str() == Some(&self.generation)
                && self.leases.get(id).is_some_and(|lease| {
                    params["lease"]["revision"].as_u64() == Some(lease.revision)
                })
            {
                self.leases.remove(id);
            }
        }

        fn paste(
            &mut self,
            params: &Value,
            acknowledge: &mut dyn FnMut() -> io::Result<()>,
        ) -> HandlerResult {
            let text = params["text"].as_str().ok_or_else(|| {
                UiaError::invalid_input("paste requires text matching the staged clipboard")
            })?;
            if text.encode_utf16().count() > MAX_TEXT_UNITS as usize {
                return Err(UiaError::invalid_input("text is too long"));
            }
            let id = lease_id(params)?;
            if let Err(reason) = self.validate_lease(params, id) {
                self.revoke_if_current(params, id);
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":reason}),
                );
            }
            let mut lease = self.leases.remove(id).unwrap();
            if lease.identity_only {
                match read_snapshot(&lease.element, true) {
                    Ok((snapshot, selection)) => {
                        if snapshot.composition_length.is_some_and(|length| length > 0) {
                            return Ok(
                                json!({"status":"rejected_before_dispatch","dispatched":false,"reason":"active_composition"}),
                            );
                        }
                        lease.snapshot = snapshot;
                        lease.selection = Some(selection);
                        lease.identity_only = false;
                    }
                    Err(reason) if identity_snapshot_unavailable(reason) => {}
                    Err(reason) => {
                        return Ok(
                            json!({"status":"rejected_before_dispatch","dispatched":false,"reason":reason}),
                        )
                    }
                }
            }
            if !self.focus_matches(
                lease.hwnd,
                &lease.element,
                lease.element_pid,
                lease.window.pid,
            ) {
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":"focus_changed"}),
                );
            }
            let expected = if lease.identity_only {
                None
            } else {
                Some(replace_utf16(&lease.snapshot, text)?)
            };
            let request = SidecarRequest {
                id: 0,
                kind: "uia_press".into(),
                params: json!({"combo":"ctrl+v"}),
            };
            if input::handle_press(&request).is_err() {
                return Ok(
                    json!({"status":"effect_unknown","dispatched":true,"reason":"native_input_incomplete"}),
                );
            }
            acknowledge().map_err(|error| UiaError::unavailable(error.to_string()))?;
            if let Some(expected) = expected {
                self.readback(id, lease, expected, text.encode_utf16().count())
            } else {
                Ok(
                    json!({"status":"delivered_unverified","dispatched":true,"reason":"text_snapshot_unavailable"}),
                )
            }
        }

        fn key(
            &mut self,
            params: &Value,
            acknowledge: &mut dyn FnMut() -> io::Result<()>,
        ) -> HandlerResult {
            let combo = match params["key"].as_str() {
                Some("enter") => "enter",
                Some("shift_enter") => "shift+enter",
                Some("ctrl_enter") => "ctrl+enter",
                _ => return Err(UiaError::invalid_input("unsupported text target key")),
            };
            let id = lease_id(params)?;
            if let Err(reason) = self.validate_lease(params, id) {
                self.revoke_if_current(params, id);
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":reason}),
                );
            }
            if self.leases[id].identity_only {
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":"text_snapshot_unavailable"}),
                );
            }
            self.leases.remove(id);
            let request = SidecarRequest {
                id: 0,
                kind: "uia_press".into(),
                params: json!({"combo":combo}),
            };
            if input::handle_press(&request).is_err() {
                return Ok(
                    json!({"status":"effect_unknown","dispatched":true,"reason":"native_input_incomplete"}),
                );
            }
            acknowledge().map_err(|error| UiaError::unavailable(error.to_string()))?;
            Ok(json!({"status":"delivered_unverified","dispatched":true,"reason":"key_dispatched"}))
        }

        fn replace(
            &mut self,
            params: &Value,
            acknowledge: &mut dyn FnMut() -> io::Result<()>,
        ) -> HandlerResult {
            let text = params["text"]
                .as_str()
                .ok_or_else(|| UiaError::invalid_input("replace requires text"))?;
            if text.encode_utf16().count() > MAX_TEXT_UNITS as usize {
                return Err(UiaError::invalid_input("text is too long"));
            }
            let start = params["start"]
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(|| UiaError::invalid_input("replace requires a UTF-16 start"))?;
            let length = params["length"]
                .as_u64()
                .and_then(|v| usize::try_from(v).ok())
                .ok_or_else(|| UiaError::invalid_input("replace requires a UTF-16 length"))?;
            let id = lease_id(params)?;
            if let Err(reason) = self.validate_lease(params, id) {
                self.revoke_if_current(params, id);
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":reason}),
                );
            }
            let lease = &self.leases[id];
            if lease.identity_only {
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":"text_snapshot_unavailable"}),
                );
            }
            let size = lease.snapshot.value.encode_utf16().count();
            if start > size || length > size - start {
                return Err(UiaError::invalid_input("replace range exceeds document"));
            }
            if text.is_empty() && length == 0 {
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":"empty_change"}),
                );
            }
            let mut next = lease.snapshot.clone();
            next.selection_start = start;
            next.selection_length = length;
            let expected = replace_utf16(&next, text)?;
            let range = match range_at_utf16(&lease.element, &lease.snapshot.value, start, length) {
                Ok(range) => range,
                Err(reason) => {
                    return Ok(
                        json!({"status":"rejected_before_dispatch","dispatched":false,"reason":reason}),
                    )
                }
            };
            // Range construction performs provider calls. Recheck immediately before Select.
            if let Err(reason) = self.validate_lease(params, id) {
                self.revoke_if_current(params, id);
                return Ok(
                    json!({"status":"rejected_before_dispatch","dispatched":false,"reason":reason}),
                );
            }
            let mut lease = self.leases.remove(id).unwrap();
            if unsafe { range.Select() }.is_err() {
                return Ok(
                    json!({"status":"effect_unknown","dispatched":true,"reason":"selection_update_unknown"}),
                );
            }
            // Select can be asynchronous. Input is allowed only after the provider reports
            // the exact replacement range with the original document and element focus.
            let deadline = Instant::now() + Duration::from_millis(250);
            loop {
                if !self.focus_matches(
                    lease.hwnd,
                    &lease.element,
                    lease.element_pid,
                    lease.window.pid,
                ) {
                    return Ok(
                        json!({"status":"effect_unknown","dispatched":true,"reason":"focus_changed_after_select"}),
                    );
                }
                if let Ok((snapshot, selection)) = read_snapshot(&lease.element, true) {
                    if snapshot.value != next.value
                        || snapshot.composition_length.is_some_and(|n| n > 0)
                    {
                        return Ok(
                            json!({"status":"effect_unknown","dispatched":true,"reason":"text_changed_after_select"}),
                        );
                    }
                    if snapshot.selection_start == start && snapshot.selection_length == length {
                        lease.snapshot = snapshot;
                        lease.selection = Some(selection);
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    return Ok(
                        json!({"status":"effect_unknown","dispatched":true,"reason":"selection_readback_mismatch"}),
                    );
                }
                sleep(Duration::from_millis(10));
            }
            if !self.focus_matches(
                lease.hwnd,
                &lease.element,
                lease.element_pid,
                lease.window.pid,
            ) {
                return Ok(
                    json!({"status":"effect_unknown","dispatched":true,"reason":"focus_changed_after_select"}),
                );
            }
            let sent = if text.is_empty() {
                input::handle_press(&SidecarRequest {
                    id: 0,
                    kind: "uia_press".into(),
                    params: json!({"combo":"backspace"}),
                })
            } else {
                input::send_text_input(text)
            };
            if sent.is_err() {
                return Ok(
                    json!({"status":"effect_unknown","dispatched":true,"reason":"native_input_incomplete"}),
                );
            }
            acknowledge().map_err(|error| UiaError::unavailable(error.to_string()))?;
            self.readback(id, lease, expected, text.encode_utf16().count())
        }

        fn readback(
            &mut self,
            id: &str,
            mut lease: Lease,
            expected: String,
            inserted_length: usize,
        ) -> HandlerResult {
            let deadline = Instant::now() + Duration::from_millis(250);
            loop {
                if !self.focus_matches(
                    lease.hwnd,
                    &lease.element,
                    lease.element_pid,
                    lease.window.pid,
                ) {
                    return Ok(
                        json!({"status":"delivered_unverified","dispatched":true,"reason":"focus_changed_after_dispatch"}),
                    );
                }
                if let Ok((snapshot, selection)) = read_snapshot(&lease.element, true) {
                    if snapshot.value == expected
                        && snapshot.selection_length == 0
                        && snapshot.selection_start
                            == lease.snapshot.selection_start + inserted_length
                        && !snapshot.composition_length.is_some_and(|n| n > 0)
                        && self.focus_matches(
                            lease.hwnd,
                            &lease.element,
                            lease.element_pid,
                            lease.window.pid,
                        )
                    {
                        lease.snapshot = snapshot;
                        lease.selection = Some(selection);
                        lease.revision += 1;
                        let result = self.snapshot_result(id, &lease);
                        self.leases.insert(id.to_string(), lease);
                        return Ok(json!({"status":"confirmed","dispatched":true,"lease":result}));
                    }
                }
                if Instant::now() >= deadline {
                    return Ok(
                        json!({"status":"delivered_unverified","dispatched":true,"reason":"text_readback_mismatch"}),
                    );
                }
                sleep(Duration::from_millis(10));
            }
        }
    }

    fn lease_id(params: &Value) -> Result<&str, UiaError> {
        params["lease"]["id"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| UiaError::invalid_input("text operation requires a lease"))
    }
    fn native_error(error: windows::core::Error) -> UiaError {
        UiaError::unavailable(format!("UIA text target: {error}"))
    }
    fn rejected(reason: &str) -> Value {
        json!({"status":"unavailable","reason":reason})
    }

    fn read_snapshot(
        element: &IUIAutomationElement,
        require_writable: bool,
    ) -> Result<(TextSnapshot, IUIAutomationTextRange), &'static str> {
        unsafe {
            if element
                .CurrentIsPassword()
                .map(|v| v.as_bool())
                .map_err(|_| "element_unavailable")?
            {
                return Err("protected_text");
            }
            if !element
                .CurrentIsEnabled()
                .map(|v| v.as_bool())
                .map_err(|_| "element_unavailable")?
            {
                return Err("disabled_target");
            }
            let pattern = element
                .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                .map_err(|_| "text_pattern_unavailable")?;
            let document = pattern
                .DocumentRange()
                .map_err(|_| "document_range_unavailable")?;
            let readonly = element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|value| value.CurrentIsReadOnly())
                .map(|value| value.as_bool())
                .ok()
                .or_else(|| {
                    document
                        .GetAttributeValue(UIA_IsReadOnlyAttributeId)
                        .ok()
                        .and_then(|value| bool::try_from(&value).ok())
                });
            if require_writable && readonly != Some(false) {
                return Err(if readonly == Some(true) {
                    "readonly_target"
                } else {
                    "writability_unknown"
                });
            }
            let ranges = pattern
                .GetSelection()
                .map_err(|_| "selection_unavailable")?;
            if ranges.Length().map_err(|_| "selection_unavailable")? != 1 {
                return Err("non_contiguous_selection");
            }
            let selection = ranges.GetElement(0).map_err(|_| "selection_unavailable")?;
            let prefix = document.Clone().map_err(|_| "range_unavailable")?;
            prefix
                .MoveEndpointByRange(
                    TextPatternRangeEndpoint_End,
                    &selection,
                    TextPatternRangeEndpoint_Start,
                )
                .map_err(|_| "range_unavailable")?;
            let suffix = document.Clone().map_err(|_| "range_unavailable")?;
            suffix
                .MoveEndpointByRange(
                    TextPatternRangeEndpoint_Start,
                    &selection,
                    TextPatternRangeEndpoint_End,
                )
                .map_err(|_| "range_unavailable")?;
            let value = range_text(&document)?;
            let before = range_text(&prefix)?;
            let selected = range_text(&selection)?;
            let after = range_text(&suffix)?;
            if format!("{before}{selected}{after}") != value {
                return Err("incoherent_text_ranges");
            }
            let composition_length = active_composition(element);
            Ok((
                TextSnapshot {
                    value,
                    selection_start: before.encode_utf16().count(),
                    selection_length: selected.encode_utf16().count(),
                    composition_length,
                },
                selection,
            ))
        }
    }

    fn range_at_utf16(
        element: &IUIAutomationElement,
        value: &str,
        start: usize,
        length: usize,
    ) -> Result<IUIAutomationTextRange, &'static str> {
        let units: Vec<u16> = value.encode_utf16().collect();
        let before = String::from_utf16(&units[..start]).map_err(|_| "range_splits_unicode")?;
        let through =
            String::from_utf16(&units[..start + length]).map_err(|_| "range_splits_unicode")?;
        let selected = String::from_utf16(&units[start..start + length])
            .map_err(|_| "range_splits_unicode")?;
        unsafe {
            let document = element
                .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                .and_then(|pattern| pattern.DocumentRange())
                .map_err(|_| "document_range_unavailable")?;
            // UIA character units vary by provider. Exact document prefixes locate UTF-16
            // boundaries without assuming one MoveEndpointByUnit step equals one code unit.
            let prefix = |text: &str| -> Result<IUIAutomationTextRange, &'static str> {
                let range = if text.is_empty() {
                    let range = document.Clone().map_err(|_| "range_unavailable")?;
                    range
                        .MoveEndpointByRange(
                            TextPatternRangeEndpoint_End,
                            &document,
                            TextPatternRangeEndpoint_Start,
                        )
                        .map_err(|_| "range_unavailable")?;
                    range
                } else {
                    document
                        .FindText(&BSTR::from(text), false, false)
                        .map_err(|_| "exact_range_unavailable")?
                };
                if range
                    .CompareEndpoints(
                        TextPatternRangeEndpoint_Start,
                        &document,
                        TextPatternRangeEndpoint_Start,
                    )
                    .map_err(|_| "range_unavailable")?
                    != 0
                    || range_text(&range)? != text
                {
                    return Err("exact_range_unavailable");
                }
                Ok(range)
            };
            let before_range = prefix(&before)?;
            let range = prefix(&through)?;
            range
                .MoveEndpointByRange(
                    TextPatternRangeEndpoint_Start,
                    &before_range,
                    TextPatternRangeEndpoint_End,
                )
                .map_err(|_| "range_unavailable")?;
            if range_text(&range)? != selected {
                return Err("exact_range_unavailable");
            }
            Ok(range)
        }
    }

    fn range_text(range: &IUIAutomationTextRange) -> Result<String, &'static str> {
        let value = unsafe { range.GetText(MAX_TEXT_UNITS + 1) }.map_err(|_| "text_unavailable")?;
        if value.len() > MAX_TEXT_UNITS as usize {
            return Err("text_too_long");
        }
        String::try_from(&value).map_err(|_| "invalid_unicode")
    }

    fn active_composition(element: &IUIAutomationElement) -> Option<usize> {
        unsafe {
            let pattern = element
                .GetCurrentPatternAs::<IUIAutomationTextEditPattern>(UIA_TextEditPatternId)
                .ok()?;
            // The generated interface maps successful null ranges to E_POINTER. Preserve
            // the documented distinction between no composition and unsupported access.
            let mut raw: *mut c_void = null_mut();
            (Interface::vtable(&pattern).GetActiveComposition)(
                Interface::as_raw(&pattern),
                &mut raw,
            )
            .ok()
            .ok()?;
            if raw.is_null() {
                return Some(0);
            }
            let range: IUIAutomationTextRange = Interface::from_raw(raw);
            range_text(&range)
                .ok()
                .map(|text| text.encode_utf16().count())
        }
    }

    fn replace_utf16(snapshot: &TextSnapshot, text: &str) -> Result<String, UiaError> {
        let value: Vec<u16> = snapshot.value.encode_utf16().collect();
        let mut result = value[..snapshot.selection_start].to_vec();
        result.extend(text.encode_utf16());
        result.extend_from_slice(&value[snapshot.selection_start + snapshot.selection_length..]);
        String::from_utf16(&result)
            .map_err(|_| UiaError::invalid_input("selection splits a Unicode scalar"))
    }

    fn identity_snapshot_unavailable(reason: &str) -> bool {
        matches!(
            reason,
            "text_pattern_unavailable"
                | "document_range_unavailable"
                | "selection_unavailable"
                | "non_contiguous_selection"
                | "text_unavailable"
                | "text_too_long"
                | "writability_unknown"
        )
    }

    fn identity_candidate(element: &IUIAutomationElement) -> bool {
        unsafe {
            element
                .CurrentIsPassword()
                .map(|value| !value.as_bool())
                .unwrap_or(false)
                && element
                    .CurrentIsEnabled()
                    .map(|value| value.as_bool())
                    .unwrap_or(false)
                && element
                    .CurrentControlType()
                    .map(|role| {
                        role == UIA_EditControlTypeId
                            || role == UIA_DocumentControlTypeId
                            || role == UIA_ComboBoxControlTypeId
                    })
                    .unwrap_or(false)
                && writable(element) != Some(false)
        }
    }

    fn writable(element: &IUIAutomationElement) -> Option<bool> {
        unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
                .and_then(|pattern| pattern.CurrentIsReadOnly())
                .map(|value| !value.as_bool())
                .ok()
                .or_else(|| {
                    element
                        .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                        .and_then(|pattern| pattern.DocumentRange())
                        .and_then(|range| range.GetAttributeValue(UIA_IsReadOnlyAttributeId))
                        .ok()
                        .and_then(|value| bool::try_from(&value).ok())
                        .map(|readonly| !readonly)
                })
        }
    }

    fn uptime_nanoseconds() -> String {
        (unsafe { GetTickCount64() } as u128 * 1_000_000).to_string()
    }
    fn snapshot_id() -> Result<String, UiaError> {
        unsafe {
            CoCreateGuid()
                .map(|id| format!("{:?}", id).to_lowercase())
                .map_err(native_error)
        }
    }
    fn window_frame(hwnd: HWND) -> Option<WindowFrame> {
        let mut frame = RECT::default();
        unsafe {
            let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            let result = GetWindowRect(hwnd, &mut frame);
            if !previous.0.is_null() {
                SetThreadDpiAwarenessContext(previous);
            }
            result.ok()?;
        }
        Some(WindowFrame {
            x: frame.left,
            y: frame.top,
            width: frame.right - frame.left,
            height: frame.bottom - frame.top,
        })
    }
    fn target_matches(target: &Value, window: &WindowInfo) -> Result<bool, UiaError> {
        if let Some(pid) = target.get("pid") {
            let pid = pid
                .as_u64()
                .filter(|pid| *pid > 0 && *pid <= u32::MAX as u64)
                .ok_or_else(|| UiaError::invalid_input("pid must be positive"))?;
            if pid != window.pid as u64 {
                return Ok(false);
            }
        }
        if let Some(title) = target.get("title") {
            let title = title
                .as_str()
                .ok_or_else(|| UiaError::invalid_input("title must be text"))?;
            if title != window.title {
                return Ok(false);
            }
        }
        if let Some(frame) = target.get("frame") {
            for key in ["x", "y", "width", "height"] {
                if frame[key]
                    .as_f64()
                    .filter(|v| v.is_finite() && (!matches!(key, "width" | "height") || *v >= 0.0))
                    .is_none()
                {
                    return Err(UiaError::invalid_input(
                        "frame requires finite desktop coordinates",
                    ));
                }
            }
            let Some(actual) = &window.frame else {
                return Ok(false);
            };
            if frame["x"].as_f64() != Some(actual.x as f64)
                || frame["y"].as_f64() != Some(actual.y as f64)
                || frame["width"].as_f64() != Some(actual.width as f64)
                || frame["height"].as_f64() != Some(actual.height as f64)
            {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn append_visible(text: &mut String, value: &str) -> bool {
        let value = value.trim();
        if value.is_empty() {
            return false;
        }
        if !text.is_empty() {
            if text.encode_utf16().count() >= 5000 {
                return true;
            }
            text.push('\n');
        }
        let mut length = text.encode_utf16().count();
        for character in value.chars() {
            length += character.len_utf16();
            if length > 5000 {
                return true;
            }
            text.push(character);
        }
        false
    }

    fn window_info(hwnd: HWND) -> WindowInfo {
        unsafe {
            let mut pid = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            let mut title = vec![0u16; 1024];
            let length = GetWindowTextW(hwnd, &mut title);
            let title = String::from_utf16_lossy(&title[..length.max(0) as usize]);
            let app_name = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .ok()
                .and_then(|process| {
                    let mut path = vec![0u16; 32768];
                    let mut length = path.len() as u32;
                    let result = QueryFullProcessImageNameW(
                        process,
                        PROCESS_NAME_WIN32,
                        PWSTR(path.as_mut_ptr()),
                        &mut length,
                    );
                    let _ = CloseHandle(process);
                    result.ok().map(|_| {
                        String::from_utf16_lossy(&path[..length as usize])
                            .rsplit('\\')
                            .next()
                            .unwrap_or("")
                            .to_string()
                    })
                })
                .unwrap_or_else(|| format!("Process {pid}"));
            WindowInfo {
                hwnd: format!("0x{:x}", hwnd.0 as usize),
                pid,
                title,
                app_name,
                frame: window_frame(hwnd),
            }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn identity_capture_does_not_override_readonly_or_protected_targets() {
            for reason in [
                "readonly_target",
                "protected_text",
                "disabled_target",
                "active_composition",
                "incoherent_text_ranges",
            ] {
                assert!(!identity_snapshot_unavailable(reason));
            }
            assert!(identity_snapshot_unavailable("selection_unavailable"));
        }
        #[test]
        fn visible_text_cap_preserves_utf16_and_unicode_scalars() {
            let mut text = "a".repeat(4998);
            assert!(append_visible(&mut text, "🙂"));
            assert!(text.encode_utf16().count() <= 5000);
            let mut text = "a".repeat(5000);
            assert!(append_visible(&mut text, "more"));
            assert_eq!(text.len(), 5000);
        }
        #[test]
        fn explicit_window_selectors_are_conjunctive() {
            let window = WindowInfo {
                hwnd: "0x123".into(),
                pid: 77,
                title: "Editor".into(),
                app_name: "editor.exe".into(),
                frame: Some(WindowFrame {
                    x: -100,
                    y: 0,
                    width: 800,
                    height: 600,
                }),
            };
            assert!(target_matches(&json!({"pid":77,"title":"Editor"}), &window).unwrap());
            assert!(!target_matches(&json!({"pid":77,"title":"Other"}), &window).unwrap());
            assert!(!target_matches(
                &json!({"frame":{"x":0,"y":0,"width":800,"height":600}}),
                &window
            )
            .unwrap());
            assert!(target_matches(&json!({"pid":"77"}), &window).is_err());
        }
    }
}

#[cfg(target_os = "windows")]
pub use native::TextTargets;

#[cfg(not(target_os = "windows"))]
#[derive(Default)]
pub struct TextTargets;
#[cfg(not(target_os = "windows"))]
impl TextTargets {
    pub fn handle(
        &mut self,
        _: &unicli_shared::SidecarRequest,
        _: &mut dyn FnMut() -> std::io::Result<()>,
    ) -> crate::errors::HandlerResult {
        Err(crate::errors::backend_unavailable())
    }
}
