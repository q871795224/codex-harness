use std::{
    fs,
    io::{Cursor, Read},
    path::{Component, Path, PathBuf},
};

use image::{
    codecs::webp::WebPDecoder, DynamicImage, ImageDecoder, ImageFormat, ImageReader, RgbaImage,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::AppState;

pub(crate) const LABEL: &str = "desktop-pet";
const SELECTED: &str = "desktopPet.selected";
const DEFAULT_PET: &str = "dafeiyu";
const VISIBLE: &str = "desktopPet.visible";
#[cfg(target_os = "macos")]
const POSITION: &str = "desktopPet.position";
const MAX_BYTES: u64 = 20 * 1024 * 1024;
const MAX_FRAMES: usize = 32;
const MAX_IDLE_ANIMATIONS: usize = 128;
const MAX_IDLE_ANIMATION_BYTES: u64 = 4 * 1024 * 1024;
const MAX_IDLE_BUNDLE_BYTES: u64 = 128 * 1024 * 1024;
const CELL_WIDTH: u32 = 192;
const CELL_HEIGHT: u32 = 208;
const COLUMNS: u32 = 8;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Source {
    Builtin,
    Codex,
    Harness,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) struct PetKey {
    source: Source,
    directory: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    id: String,
    display_name: String,
    #[serde(default)]
    description: String,
    #[serde(default = "version_one")]
    sprite_version_number: u8,
    spritesheet_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    idle_frames: Option<u8>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    idle_animations: Vec<IdleAnimation>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IdleAnimation {
    path: PathBuf,
    duration_ms: u32,
}

fn version_one() -> u8 {
    1
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pet {
    key: PetKey,
    name: String,
    description: String,
    version: u8,
    idle_frames: u8,
    idle_animation_durations: Vec<u32>,
}

#[derive(Serialize)]
pub(crate) struct Catalog {
    supported: bool,
    visible: bool,
    selected: Option<PetKey>,
    pets: Vec<Pet>,
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activity {
    status: PetStatus,
    count: usize,
    thread_id: Option<String>,
    notification_id: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum PetStatus {
    #[default]
    Idle,
    Running,
    Waiting,
    Failed,
    Ready,
}

#[derive(Serialize)]
pub(crate) struct Snapshot {
    visible: bool,
    pet: Option<Pet>,
    activity: Activity,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTarget {
    thread_id: Option<String>,
    notification_id: Option<String>,
}

pub(crate) fn allows_command(command: &str) -> bool {
    matches!(
        command,
        "desktop_pet_asset"
            | "desktop_pet_snapshot"
            | "desktop_pet_open"
            | "desktop_pet_menu"
            | "desktop_pet_drag"
            | "desktop_pet_visibility"
    )
}

pub(crate) fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .is_some_and(|pet| pet.is_visible().unwrap_or(false))
}

pub(crate) fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let app = window.app_handle();
    match window.label() {
        "main" if is_visible(app) => {
            api.prevent_close();
            let _ = window.hide();
        }
        "main" => {
            if let Some(pet) = app.get_webview_window(LABEL) {
                let _ = pet.destroy();
            }
            if let Some(assistant) = app.get_webview_window(crate::desktop_assistant::LABEL) {
                let _ = assistant.destroy();
            }
        }
        crate::desktop_assistant::LABEL => {
            api.prevent_close();
            let _ = window.hide();
        }
        LABEL => {
            api.prevent_close();
            let _ = hide_pet(app, true);
            let _ = app
                .state::<AppState>()
                .store
                .set_app_state(VISIBLE, "false");
            let _ = changed(app);
            let _ = app.emit_to("main", "desktop-pet:visibility", false);
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn reopen_main(app: &AppHandle) {
    if is_visible(app) {
        let _ = show_main(app);
    }
}

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("宠物管理仅在主窗口可用。".into())
    }
}

fn pet_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err("此操作仅在宠物窗口可用。".into())
    }
}

fn io(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn root(app: &AppHandle, source: Source) -> Result<PathBuf, String> {
    match source {
        Source::Builtin => {
            let bundled = app.path().resource_dir().map(|dir| dir.join("pets"));
            if cfg!(debug_assertions)
                && !bundled
                    .as_ref()
                    .is_ok_and(|dir| dir.join(DEFAULT_PET).join("pet.json").is_file())
            {
                return Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pets"));
            }
            bundled.map_err(io)
        }
        Source::Codex => crate::app_server::resolved_codex_home().map(|dir| dir.join("pets")),
        Source::Harness => crate::store::harness_data_dir().map(|dir| dir.join("pets")),
    }
}

fn inside(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(io)?;
    if !resolved.starts_with(root) || resolved == root {
        return Err("宠物资源必须位于选中的目录内。".into());
    }
    Ok(resolved)
}

fn relative_path(path: &Path) -> bool {
    path.components().next().is_some()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn package_directory(root: &Path, name: &str) -> Result<PathBuf, String> {
    let name = Path::new(name);
    if !relative_path(name) || name.components().count() != 1 {
        return Err("宠物目录名无效。".into());
    }
    inside(&root.join(name), &root.canonicalize().map_err(io)?)
}

fn read_bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    if !fs::metadata(path).map_err(io)?.is_file() {
        return Err("宠物资源必须是普通文件。".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(io)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > limit {
        return Err("宠物资源文件过大。".into());
    }
    Ok(bytes)
}

fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(io)?;
    if !matches!(reader.format(), Some(ImageFormat::Png | ImageFormat::WebP)) {
        return Err("宠物图片需为 PNG 或 WebP。".into());
    }
    Ok(reader)
}

fn manifest(dir: &Path, source: Source) -> Result<(Manifest, PathBuf), String> {
    let dir = dir.canonicalize().map_err(io)?;
    let path = inside(&dir.join("pet.json"), &dir)?;
    let manifest: Manifest = serde_json::from_slice(&read_bytes(&path, 32 * 1024)?).map_err(io)?;
    if manifest.display_name.trim().is_empty() || manifest.id.trim().is_empty() {
        return Err("宠物名称和标识不能为空。".into());
    }
    let image = Path::new(&manifest.spritesheet_path);
    if !relative_path(image) {
        return Err("精灵图需要使用包内相对路径。".into());
    }
    let image = inside(&dir.join(image), &dir)?;
    dimensions(&manifest, source)?;
    if manifest.idle_animations.len() > MAX_IDLE_ANIMATIONS
        || manifest
            .idle_animations
            .iter()
            .any(|clip| !relative_path(&clip.path) || !(100..=30_000).contains(&clip.duration_ms))
    {
        return Err("待机动作路径、数量或时长无效。".into());
    }
    Ok((manifest, image))
}

fn dimensions(manifest: &Manifest, source: Source) -> Result<(u32, u32, u8), String> {
    let (rows, idle_frames) = match (manifest.sprite_version_number, source) {
        (1, _) => (9, 6),
        (2, _) => (11, 6),
        (0, Source::Harness) => {
            let count = manifest
                .idle_frames
                .filter(|count| (1..=MAX_FRAMES).contains(&usize::from(*count)))
                .ok_or("待机帧数量无效。")?;
            (u32::from(count).div_ceil(COLUMNS), count)
        }
        _ => return Err("不支持该宠物格式版本。".into()),
    };
    Ok((CELL_WIDTH * COLUMNS, CELL_HEIGHT * rows, idle_frames))
}

fn asset(manifest: &Manifest, image: &Path, source: Source) -> Result<Vec<u8>, String> {
    let bytes = read_bytes(image, MAX_BYTES)?;
    let (width, height, _) = dimensions(manifest, source)?;
    if reader(&bytes)?.into_dimensions().map_err(io)? != (width, height) {
        return Err(format!("精灵图尺寸应为 {width} × {height} 像素。"));
    }
    Ok(bytes)
}

fn idle_animation(directory: &Path, clip: &IdleAnimation) -> Result<Vec<u8>, String> {
    let path = inside(
        &directory.join(&clip.path),
        &directory.canonicalize().map_err(io)?,
    )?;
    let bytes = read_bytes(&path, MAX_IDLE_ANIMATION_BYTES)?;
    let decoder = WebPDecoder::new(Cursor::new(&bytes)).map_err(io)?;
    let (width, height) = decoder.dimensions();
    if !decoder.has_animation()
        || !decoder.color_type().has_alpha()
        || width > 1024
        || height > 1024
    {
        return Err("待机动作需为宽高均不超过 1024 像素的透明 WebP 动画。".into());
    }
    Ok(bytes)
}

fn describe(key: PetKey, manifest: Manifest) -> Pet {
    Pet {
        name: manifest.display_name,
        description: manifest.description,
        version: manifest.sprite_version_number,
        idle_frames: manifest.idle_frames.unwrap_or(6),
        idle_animation_durations: manifest
            .idle_animations
            .iter()
            .map(|clip| clip.duration_ms)
            .collect(),
        key,
    }
}

fn find(app: &AppHandle, key: &PetKey) -> Result<(Manifest, PathBuf), String> {
    manifest(
        &package_directory(&root(app, key.source)?, &key.directory)?,
        key.source,
    )
}

fn list_at(root: &Path, source: Source) -> Vec<Pet> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let directory = entry.file_name().into_string().ok()?;
            if directory.starts_with('.') {
                return None;
            }
            let dir = package_directory(root, &directory).ok()?;
            let (manifest, _) = manifest(&dir, source).ok()?;
            Some(describe(PetKey { source, directory }, manifest))
        })
        .collect()
}

fn selected_key(stored: Option<&str>) -> PetKey {
    stored
        .and_then(|stored| serde_json::from_str(stored).ok())
        .unwrap_or_else(|| PetKey {
            source: Source::Builtin,
            directory: DEFAULT_PET.into(),
        })
}

fn selected(state: &AppState) -> Result<PetKey, String> {
    Ok(selected_key(
        state.store.get_app_state(SELECTED)?.as_deref(),
    ))
}

fn selected_pet(app: &AppHandle, state: &AppState) -> Result<Option<Pet>, String> {
    let key = selected(state)?;
    Ok(find(app, &key)
        .ok()
        .map(|(manifest, _)| describe(key, manifest)))
}

fn save_import(
    root: &Path,
    mut manifest: Manifest,
    bytes: &[u8],
    source_folder: Option<&Path>,
) -> Result<PetKey, String> {
    fs::create_dir_all(root).map_err(io)?;
    let staging = tempfile::Builder::new()
        .prefix(".pet-")
        .tempdir_in(root)
        .map_err(io)?;
    let directory = staging
        .path()
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix('.'))
        .ok_or("无法创建宠物目录。")?
        .to_owned();
    manifest.id = directory.clone();
    manifest.spritesheet_path = match reader(bytes)?.format() {
        Some(ImageFormat::WebP) => "spritesheet.webp",
        _ => "spritesheet.png",
    }
    .into();
    fs::write(staging.path().join(&manifest.spritesheet_path), bytes).map_err(io)?;
    if let Some(source) = source_folder.filter(|_| !manifest.idle_animations.is_empty()) {
        fs::create_dir(staging.path().join("idle")).map_err(io)?;
        let mut total = 0;
        for (index, clip) in manifest.idle_animations.iter_mut().enumerate() {
            let animation = idle_animation(source, clip)?;
            total += animation.len() as u64;
            if total > MAX_IDLE_BUNDLE_BYTES {
                return Err("待机动作共计不能超过 128 MiB。".into());
            }
            clip.path = PathBuf::from(format!("idle/{index}.webp"));
            fs::write(staging.path().join(&clip.path), animation).map_err(io)?;
        }
    }
    fs::write(
        staging.path().join("pet.json"),
        serde_json::to_vec(&manifest).map_err(io)?,
    )
    .map_err(io)?;
    fs::rename(staging.path(), root.join(&directory)).map_err(io)?;
    Ok(PetKey {
        source: Source::Harness,
        directory,
    })
}

fn import_folder(destination: &Path, directory: &Path) -> Result<PetKey, String> {
    let (manifest, image) = manifest(directory, Source::Codex)?;
    let bytes = asset(&manifest, &image, Source::Codex)?;
    validate_transparent(reader(&bytes)?.decode().map_err(io)?)?;
    save_import(destination, manifest, &bytes, Some(directory))
}

fn validate_transparent(picture: DynamicImage) -> Result<RgbaImage, String> {
    let rgba = picture.into_rgba8();
    if !rgba.pixels().any(|pixel| pixel.0[3] < 255) || !rgba.pixels().any(|pixel| pixel.0[3] > 0) {
        return Err("宠物图片需包含透明背景和可见内容。".into());
    }
    Ok(rgba)
}

fn import_frames(destination: &Path, mut paths: Vec<PathBuf>) -> Result<PetKey, String> {
    if !(1..=MAX_FRAMES).contains(&paths.len()) {
        return Err(format!("请选择 1–{MAX_FRAMES} 张透明图片。"));
    }
    paths.sort_by(|a, b| a.file_name().cmp(&b.file_name()).then_with(|| a.cmp(b)));
    let frames = paths.len() as u8;
    let name = paths[0]
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("自定义宠物")
        .to_owned();
    let mut atlas = RgbaImage::new(
        CELL_WIDTH * COLUMNS,
        CELL_HEIGHT * u32::from(frames).div_ceil(COLUMNS),
    );
    for (index, path) in paths.iter().enumerate() {
        let bytes = read_bytes(path, MAX_BYTES)?;
        let (width, height) = reader(&bytes)?.into_dimensions().map_err(io)?;
        if width > 4096 || height > 4096 {
            return Err("每张图片的宽高上限为 4096 像素。".into());
        }
        let image = validate_transparent(reader(&bytes)?.decode().map_err(io)?)?;
        let frame = DynamicImage::ImageRgba8(image)
            .thumbnail(CELL_WIDTH, CELL_HEIGHT)
            .into_rgba8();
        let x = (index as u32 % COLUMNS) * CELL_WIDTH + (CELL_WIDTH - frame.width()) / 2;
        let y = (index as u32 / COLUMNS) * CELL_HEIGHT + (CELL_HEIGHT - frame.height()) / 2;
        image::imageops::replace(&mut atlas, &frame, i64::from(x), i64::from(y));
    }
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(atlas)
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(io)?;
    save_import(
        destination,
        Manifest {
            id: String::new(),
            display_name: name,
            description: "按文件名播放的待机帧".into(),
            sprite_version_number: 0,
            spritesheet_path: String::new(),
            idle_frames: Some(frames),
            idle_animations: Vec::new(),
        },
        &bytes.into_inner(),
        None,
    )
}

#[tauri::command]
pub(crate) async fn desktop_pet_catalog(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Catalog, String> {
    main_only(&window)?;
    let resources = app.clone();
    let mut pets = tauri::async_runtime::spawn_blocking(move || {
        [Source::Builtin, Source::Codex, Source::Harness]
            .into_iter()
            .flat_map(|source| {
                root(&resources, source)
                    .map(|root| list_at(&root, source))
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(io)?;
    pets.sort_by_cached_key(|pet| (pet.key.source != Source::Builtin, pet.name.to_lowercase()));
    let selected = selected(&state)?;
    Ok(Catalog {
        supported: cfg!(target_os = "macos"),
        visible: is_visible(&app),
        selected: pets
            .iter()
            .any(|pet| pet.key == selected)
            .then_some(selected),
        pets,
    })
}

#[tauri::command]
pub(crate) async fn desktop_pet_import(
    window: WebviewWindow,
    folder: Option<PathBuf>,
    frames: Option<Vec<PathBuf>>,
) -> Result<PetKey, String> {
    main_only(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let destination = root(&app, Source::Harness)?;
        match (folder, frames) {
            (Some(path), None) => import_folder(&destination, &path),
            (None, Some(paths)) => import_frames(&destination, paths),
            _ => Err("请选择一个 Codex 宠物目录或一组图片。".into()),
        }
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) async fn desktop_pet_select(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    key: PetKey,
) -> Result<(), String> {
    main_only(&window)?;
    let validate = key.clone();
    let resources = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (manifest, image) = find(&resources, &validate)?;
        let bytes = asset(&manifest, &image, validate.source)?;
        validate_transparent(reader(&bytes)?.decode().map_err(io)?)?;
        Ok::<_, String>(())
    })
    .await
    .map_err(io)??;
    state
        .store
        .set_app_state(SELECTED, &serde_json::to_string(&key).map_err(io)?)?;
    changed(&app)
}

#[tauri::command]
pub(crate) async fn desktop_pet_asset(
    window: WebviewWindow,
    key: PetKey,
    animation: Option<usize>,
) -> Result<tauri::ipc::Response, String> {
    if !matches!(window.label(), "main" | LABEL) {
        return Err("无权读取宠物资源。".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let directory = package_directory(&root(&app, key.source)?, &key.directory)?;
        let (manifest, path) = manifest(&directory, key.source)?;
        let bytes = match animation {
            Some(index) => {
                let clip = manifest
                    .idle_animations
                    .get(index)
                    .ok_or("待机动作不存在。")?;
                idle_animation(&directory, clip)?
            }
            None => asset(&manifest, &path, key.source)?,
        };
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(io)?
}

#[tauri::command]
pub(crate) fn desktop_pet_snapshot(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    pet_only(&window)?;
    Ok(Snapshot {
        visible: window.is_visible().map_err(io)?,
        pet: selected_pet(window.app_handle(), &state)?,
        activity: state.desktop_pet_activity.lock().map_err(io)?.clone(),
    })
}

#[tauri::command]
pub(crate) fn desktop_pet_publish(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    activity: Activity,
) -> Result<(), String> {
    main_only(&window)?;
    let mut latest = state.desktop_pet_activity.lock().map_err(io)?;
    if *latest == activity {
        return Ok(());
    }
    *latest = activity;
    changed(&app)
}

fn changed(app: &AppHandle) -> Result<(), String> {
    app.emit_to(LABEL, "desktop-pet:changed", ()).map_err(io)
}

fn show_main(app: &AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("找不到 Harness 主窗口。")?;
    main.show().map_err(io)?;
    main.unminimize().map_err(io)?;
    main.set_focus().map_err(io)
}

fn hide_pet(app: &AppHandle, restore_main: bool) -> Result<(), String> {
    crate::desktop_assistant::hide(app);
    if let Some(pet) = app.get_webview_window(LABEL) {
        if restore_main
            && app
                .get_webview_window("main")
                .is_some_and(|main| !main.is_visible().unwrap_or(false))
        {
            show_main(app)?;
        }
        pet.hide().map_err(io)?;
    }
    Ok(())
}

fn open_notice(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let activity = state.desktop_pet_activity.lock().map_err(io)?.clone();
    show_main(app)?;
    app.emit_to(
        "main",
        "desktop-pet:open",
        OpenTarget {
            thread_id: activity.thread_id,
            notification_id: activity.notification_id,
        },
    )
    .map_err(io)
}

#[tauri::command]
pub(crate) async fn desktop_pet_open(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    pet_only(&window)?;
    crate::desktop_assistant::show(&app)
}

#[tauri::command]
pub(crate) async fn desktop_pet_menu(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    pet_only(&window)?;
    use tauri::menu::{Menu, MenuItem};
    let open = MenuItem::with_id(
        &app,
        "desktop-pet-conversation",
        "打开助理会话",
        true,
        None::<&str>,
    )
    .map_err(io)?;
    let notice = MenuItem::with_id(
        &app,
        "desktop-pet-notifications",
        "查看通知",
        true,
        None::<&str>,
    )
    .map_err(io)?;
    let hide = MenuItem::with_id(&app, "desktop-pet-hide", "隐藏桌面宠物", true, None::<&str>)
        .map_err(io)?;
    let menu = Menu::with_items(&app, &[&open, &notice, &hide]).map_err(io)?;
    window.popup_menu(&menu).map_err(io)
}

#[tauri::command]
pub(crate) async fn desktop_pet_drag(window: WebviewWindow) -> Result<(), String> {
    pet_only(&window)?;
    #[cfg(not(target_os = "macos"))]
    return Err("此版本的桌面宠物仅支持 macOS。".into());
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceButtonState(source_state: i32, button: u32) -> bool;
        }
        let initial = window.outer_position().map_err(io)?;
        let pointer = window.cursor_position().map_err(io)?;
        let mut last = initial;
        // Session button state lets an asynchronous long press continue tracking
        // the same held button without relying on the WebKit event's lifetime.
        while unsafe { CGEventSourceButtonState(0, 0) } {
            let current = window.cursor_position().map_err(io)?;
            let point = tauri::PhysicalPosition::new(
                initial.x + (current.x - pointer.x).round() as i32,
                initial.y + (current.y - pointer.y).round() as i32,
            );
            if point != last {
                window.set_position(point).map_err(io)?;
                last = point;
            }
            tokio::time::sleep(std::time::Duration::from_millis(16)).await;
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn desktop_pet_visibility(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    visible: Option<bool>,
) -> Result<bool, String> {
    if window.label() != "main" && !(window.label() == LABEL && visible == Some(false)) {
        return Err("无权显示桌面宠物。".into());
    }
    let _window = state.desktop_pet_window.lock().await;
    let should_show =
        visible.unwrap_or(state.store.get_app_state(VISIBLE)?.as_deref() == Some("true"));
    if should_show {
        if selected_pet(&app, &state)?.is_none() {
            if visible.is_none() {
                return Ok(false);
            }
            return Err("请先选择宠物。".into());
        }
        show_pet(&app, &state)?;
    } else {
        hide_pet(&app, window.label() == LABEL)?;
    }
    if visible.is_some() {
        state
            .store
            .set_app_state(VISIBLE, if should_show { "true" } else { "false" })?;
    }
    changed(&app)?;
    app.emit_to("main", "desktop-pet:visibility", should_show)
        .map_err(io)?;
    Ok(should_show)
}

#[cfg(not(target_os = "macos"))]
fn show_pet(_app: &AppHandle, _state: &AppState) -> Result<(), String> {
    Err("此版本的桌面宠物仅支持 macOS。".into())
}

#[cfg(target_os = "macos")]
fn show_pet(app: &AppHandle, state: &AppState) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };

    if let Some(window) = app.get_webview_window(LABEL) {
        return window.show().map_err(io);
    }
    let window = tauri::WebviewWindowBuilder::new(
        app,
        LABEL,
        tauri::WebviewUrl::App("index.html?desktop-pet".into()),
    )
    .title("Harness 宠物")
    .inner_size(135.0, 145.0)
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .shadow(false)
    .focused(false)
    .accept_first_mouse(true)
    .visible(false)
    .build()
    .map_err(io)?;
    window.on_menu_event(|window, event| {
        let app = window.app_handle().clone();
        let action = event.id().as_ref().to_owned();
        tauri::async_runtime::spawn(async move {
            match action.as_str() {
                "desktop-pet-conversation" => {
                    let _ = crate::desktop_assistant::show(&app);
                }
                "desktop-pet-notifications" => {
                    let _ = open_notice(&app);
                }
                "desktop-pet-hide" => {
                    if let Some(pet) = app.get_webview_window(LABEL) {
                        let _ = pet.close();
                    }
                }
                _ => {}
            }
        });
    });
    let saved = state
        .store
        .get_app_state(POSITION)?
        .and_then(|value| serde_json::from_str::<(i32, i32)>(&value).ok());
    if let Some(point) = window_position(&window, saved) {
        let _ = window.set_position(point);
    }
    let store = state.store.clone();
    let position_revision = Arc::new(AtomicU64::new(0));
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Moved(point) = event {
            let coordinates = (point.x, point.y);
            let version = position_revision.fetch_add(1, Ordering::Relaxed) + 1;
            let (store, revision) = (store.clone(), position_revision.clone());
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                if revision.load(Ordering::Relaxed) == version {
                    let _ = store
                        .set_app_state(POSITION, &format!("[{},{}]", coordinates.0, coordinates.1));
                }
            });
        }
    });
    window.show().map_err(io)
}

#[cfg(target_os = "macos")]
fn window_position(
    window: &WebviewWindow,
    saved: Option<(i32, i32)>,
) -> Option<tauri::PhysicalPosition<i32>> {
    let monitors = window.available_monitors().ok()?;
    let size = window.outer_size().ok()?;
    if let Some((x, y)) = saved {
        if monitors.iter().any(|monitor| {
            let area = monitor.work_area();
            x >= area.position.x
                && y >= area.position.y
                && i64::from(x) + i64::from(size.width)
                    <= i64::from(area.position.x) + i64::from(area.size.width)
                && i64::from(y) + i64::from(size.height)
                    <= i64::from(area.position.y) + i64::from(area.size.height)
        }) {
            return Some(tauri::PhysicalPosition::new(x, y));
        }
    }
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())?;
    let area = monitor.work_area();
    let margin = (18.0 * monitor.scale_factor()) as u32;
    Some(tauri::PhysicalPosition::new(
        area.position.x + margin.min(area.size.width.saturating_sub(size.width)) as i32,
        area.position.y + area.size.height.saturating_sub(size.height + margin) as i32,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_asset(path: &Path, width: u32, height: u32, color: [u8; 4]) {
        let mut picture = RgbaImage::new(width, height);
        picture.put_pixel(width / 2, height / 2, image::Rgba(color));
        picture.save(path).unwrap();
    }

    #[test]
    fn defaults_to_the_builtin_pet_and_preserves_an_existing_selection() {
        let default = selected_key(None);
        assert_eq!(default.source, Source::Builtin);
        assert_eq!(default.directory, "dafeiyu");
        assert_eq!(
            selected_key(Some(r#"{"source":"codex","directory":"my-pet"}"#)),
            PetKey {
                source: Source::Codex,
                directory: "my-pet".into()
            },
        );
    }

    #[test]
    fn bundled_dafeiyu_has_a_transparent_atlas_and_all_idle_actions() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("pets");
        let pets = list_at(&root, Source::Builtin);
        let selected = selected_key(None);
        assert!(pets
            .iter()
            .any(|pet| pet.key == selected && pet.name == "大肥鱼"));
        let directory = package_directory(&root, &selected.directory).unwrap();
        let (manifest, image) = manifest(&directory, Source::Builtin).unwrap();
        let sheet = asset(&manifest, &image, Source::Builtin).unwrap();
        validate_transparent(reader(&sheet).unwrap().decode().unwrap()).unwrap();
        assert_eq!(manifest.idle_animations.len(), 89);
        assert!(manifest
            .idle_animations
            .iter()
            .any(|clip| clip.path.ends_with("舞狮头.webp")));
        for clip in &manifest.idle_animations {
            idle_animation(&directory, clip)
                .unwrap_or_else(|error| panic!("{:?}: {error}", clip.path));
        }
    }

    #[test]
    fn imports_both_codex_atlas_versions_and_keeps_the_source_packages_unchanged() {
        let fixture = tempfile::tempdir().unwrap();
        let imported = fixture.path().join("imported");
        for (version, height) in [(1, 1872), (2, 2288)] {
            let folder = fixture.path().join(format!("v{version}"));
            fs::create_dir(&folder).unwrap();
            write_asset(&folder.join("sheet.webp"), 1536, height, [100, 70, 40, 255]);
            let original = if version == 1 {
                serde_json::json!({ "id": "test", "displayName": "Test", "spritesheetPath": "sheet.webp" })
            } else {
                serde_json::json!({ "id": "test", "displayName": "Test", "spritesheetPath": "sheet.webp", "spriteVersionNumber": 2 })
            };
            fs::write(folder.join("pet.json"), original.to_string()).unwrap();
            let key = import_folder(&imported, &folder).unwrap();
            let (manifest, sheet) =
                manifest(&imported.join(key.directory), Source::Harness).unwrap();
            assert_eq!(manifest.sprite_version_number, version);
            assert_eq!(image::image_dimensions(sheet).unwrap(), (1536, height));
            assert_eq!(
                fs::read_to_string(folder.join("pet.json")).unwrap(),
                original.to_string()
            );
        }
        assert_eq!(list_at(&imported, Source::Harness).len(), 2);
    }

    #[test]
    fn imports_idle_actions_with_the_package_and_rejects_unsafe_files_atomically() {
        let fixture = tempfile::tempdir().unwrap();
        let folder = fixture.path().join("pet");
        let destination = fixture.path().join("imported");
        fs::create_dir(&folder).unwrap();
        write_asset(&folder.join("image.png"), 1536, 1872, [255, 0, 0, 255]);
        let preview = include_bytes!("../tests/fixtures/desktop-pet-idle.webp");
        fs::write(folder.join("dance.webp"), preview).unwrap();
        let mut original = serde_json::json!({
            "id": "test", "displayName": "Test", "spritesheetPath": "image.png",
            "idleAnimations": [
                {"path": "dance.webp", "durationMs": 200},
                {"path": "missing.webp", "durationMs": 200}
            ]
        });
        let manifest_path = folder.join("pet.json");
        fs::write(&manifest_path, original.to_string()).unwrap();
        assert!(import_folder(&destination, &folder).is_err());
        assert!(fs::read_dir(&destination).unwrap().next().is_none());

        original["idleAnimations"][1]["path"] = serde_json::json!("../outside.webp");
        fs::write(&manifest_path, original.to_string()).unwrap();
        assert!(import_folder(&destination, &folder)
            .unwrap_err()
            .contains("待机动作路径"));
        assert!(fs::read_dir(&destination).unwrap().next().is_none());

        original["idleAnimations"].as_array_mut().unwrap().pop();
        fs::write(&manifest_path, original.to_string()).unwrap();
        let key = import_folder(&destination, &folder).unwrap();
        let imported = destination.join(&key.directory);
        let (manifest, _) = manifest(&imported, Source::Harness).unwrap();
        fs::remove_file(folder.join("dance.webp")).unwrap();
        assert_eq!(
            idle_animation(&imported, &manifest.idle_animations[0]).unwrap(),
            preview
        );
        assert_eq!(describe(key, manifest).idle_animation_durations, vec![200]);
    }

    #[test]
    fn builds_an_idle_atlas_in_filename_order() {
        let fixture = tempfile::tempdir().unwrap();
        let early = fixture.path().join("01.png");
        let late = fixture.path().join("02.png");
        write_asset(&early, 192, 208, [255, 0, 0, 255]);
        write_asset(&late, 192, 208, [0, 0, 255, 255]);
        let imported = fixture.path().join("imported");
        let key = import_frames(&imported, vec![late, early]).unwrap();
        let (manifest, sheet) = manifest(&imported.join(key.directory), Source::Harness).unwrap();
        assert_eq!(manifest.idle_frames, Some(2));
        let sheet = image::open(sheet).unwrap().to_rgba8();
        assert_eq!(sheet.get_pixel(96, 104).0, [255, 0, 0, 255]);
        assert_eq!(sheet.get_pixel(288, 104).0, [0, 0, 255, 255]);
        assert_eq!(sheet.get_pixel(384, 104).0[3], 0);
    }

    #[test]
    fn rejects_invalid_atlases_and_resource_paths_outside_the_package() {
        let fixture = tempfile::tempdir().unwrap();
        let folder = fixture.path().join("pet");
        fs::create_dir(&folder).unwrap();
        write_asset(&folder.join("image.png"), 1536, 1872, [255, 0, 0, 255]);
        let mut original = serde_json::json!({ "id": "test", "displayName": "Test", "spritesheetPath": "image.png", "spriteVersionNumber": 2 });
        let manifest_path = folder.join("pet.json");
        fs::write(&manifest_path, original.to_string()).unwrap();
        let destination = fixture.path().join("imported");
        assert!(import_folder(&destination, &folder)
            .unwrap_err()
            .contains("2288"));
        original["spritesheetPath"] = serde_json::json!("../outside.png");
        fs::write(&manifest_path, original.to_string()).unwrap();
        assert!(import_folder(&destination, &folder)
            .unwrap_err()
            .contains("包内"));
        assert!(!destination.exists());
        assert!(package_directory(fixture.path(), "..").is_err());
    }

    #[test]
    fn restricts_the_pet_window_to_its_own_application_commands() {
        assert!(allows_command("desktop_pet_open"));
        assert!(allows_command("desktop_pet_asset"));
        assert!(!allows_command("desktop_pet_publish"));
        assert!(!allows_command("get_app_state"));
        assert!(!allows_command("app_server_request"));
    }
}
