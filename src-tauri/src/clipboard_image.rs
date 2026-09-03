use arboard::Clipboard;
use image::{DynamicImage, ImageFormat, RgbaImage};
use serde::Serialize;
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use tempfile::Builder;

const SUPPORTED_EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposerImage {
    path: String,
    name: String,
    width: u32,
    height: u32,
}

pub fn paste() -> Result<ComposerImage, String> {
    let mut clipboard = Clipboard::new().map_err(|error| format!("无法访问系统剪贴板：{error}"))?;
    let image = match clipboard_file_image(&mut clipboard) {
        Some(image) => image,
        None => clipboard_pixel_image(&mut clipboard)?,
    };
    persist_png(image)
}

pub fn validate(path: &str) -> Result<ComposerImage, String> {
    let path = PathBuf::from(path);
    if !is_supported_path(&path) {
        return Err("仅支持 PNG、JPEG、GIF 和 WebP 图片".to_string());
    }
    let (width, height) = image::image_dimensions(&path)
        .map_err(|error| format!("无法读取图片 {}：{error}", path.display()))?;
    composer_image(path, width, height)
}

fn clipboard_file_image(clipboard: &mut Clipboard) -> Option<DynamicImage> {
    clipboard
        .get()
        .file_list()
        .ok()?
        .into_iter()
        .find_map(|path| image::open(path).ok())
}

fn clipboard_pixel_image(clipboard: &mut Clipboard) -> Result<DynamicImage, String> {
    let image = clipboard
        .get_image()
        .map_err(|error| format!("无法读取剪贴板图片：{error}"))?;
    let width = u32::try_from(image.width).map_err(|_| "剪贴板图片宽度无效".to_string())?;
    let height = u32::try_from(image.height).map_err(|_| "剪贴板图片高度无效".to_string())?;
    let rgba = RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| "剪贴板图片像素数据无效".to_string())?;
    Ok(DynamicImage::ImageRgba8(rgba))
}

fn persist_png(image: DynamicImage) -> Result<ComposerImage, String> {
    let (width, height) = (image.width(), image.height());
    let mut bytes = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|error| format!("无法编码剪贴板图片：{error}"))?;
    let temporary = Builder::new()
        .prefix("codex-harness-clipboard-")
        .suffix(".png")
        .tempfile()
        .map_err(|error| format!("无法创建图片临时文件：{error}"))?;
    fs::write(temporary.path(), bytes).map_err(|error| format!("无法写入图片临时文件：{error}"))?;
    let (_file, path) = temporary
        .keep()
        .map_err(|error| format!("无法保留图片临时文件：{}", error.error))?;
    composer_image(path, width, height)
}

fn composer_image(path: PathBuf, width: u32, height: u32) -> Result<ComposerImage, String> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("图片路径缺少有效文件名：{}", path.display()))?
        .to_string();
    Ok(ComposerImage {
        path: path.to_string_lossy().into_owned(),
        name,
        width,
        height,
    })
}

fn is_supported_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            SUPPORTED_EXTENSIONS
                .iter()
                .any(|item| extension.eq_ignore_ascii_case(item))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn validates_supported_images_by_content() {
        let directory = tempfile::tempdir().expect("creates temp directory");
        let path = directory.path().join("sample.png");
        ImageBuffer::from_pixel(3, 2, Rgba([1_u8, 2, 3, 255]))
            .save(&path)
            .expect("writes png");

        let image = validate(path.to_str().expect("utf-8 path")).expect("validates png");

        assert_eq!(image.width, 3);
        assert_eq!(image.height, 2);
        assert_eq!(image.name, "sample.png");
    }

    #[test]
    fn rejects_unsupported_extensions_and_invalid_content() {
        let directory = tempfile::tempdir().expect("creates temp directory");
        let text_path = directory.path().join("sample.txt");
        fs::write(&text_path, b"not an image").expect("writes text");
        assert!(validate(text_path.to_str().expect("utf-8 path")).is_err());

        let image_path = directory.path().join("broken.png");
        fs::write(&image_path, b"not an image").expect("writes invalid image");
        assert!(validate(image_path.to_str().expect("utf-8 path")).is_err());
    }

    #[test]
    fn persists_clipboard_pixels_as_png() {
        let image =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 1, Rgba([10_u8, 20, 30, 255])));

        let persisted = persist_png(image).expect("persists png");
        let path = PathBuf::from(&persisted.path);
        assert_eq!(
            image::image_dimensions(&path).expect("reads persisted png"),
            (2, 1)
        );
        fs::remove_file(path).expect("removes test temporary image");
    }
}
