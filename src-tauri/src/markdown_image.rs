use image::{ImageFormat, ImageReader};
use std::{
    fs::File,
    io::{Cursor, Read},
    path::Path,
};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

pub fn read(path: &str, cwd: Option<&str>) -> Result<Vec<u8>, String> {
    let path = Path::new(path);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        let cwd = cwd
            .filter(|cwd| Path::new(cwd).is_absolute())
            .ok_or("相对图片路径缺少会话工作目录")?;
        Path::new(cwd).join(path)
    };
    let metadata =
        std::fs::metadata(&resolved).map_err(|error| format!("无法读取图片信息：{error}"))?;
    if !metadata.is_file() {
        return Err("图片路径不是普通文件".into());
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 20 MiB，无法预览".into());
    }
    let file = File::open(&resolved).map_err(|error| format!("无法打开图片：{error}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取图片：{error}"))?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("图片超过 20 MiB，无法预览".into());
    }
    let format = image::guess_format(&bytes).map_err(|_| "无法识别图片格式")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err("仅支持 PNG、JPEG、GIF 和 WebP 图片".into());
    }
    let (width, height) = ImageReader::with_format(Cursor::new(&bytes), format)
        .into_dimensions()
        .map_err(|error| format!("图片内容无效：{error}"))?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 100_000_000 {
        return Err("图片尺寸超出预览范围".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn reads_absolute_and_relative_paths_with_spaces_and_chinese() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("工作区 截图.png");
        ImageBuffer::from_pixel(3, 2, Rgba([1_u8, 2, 3, 255]))
            .save(&path)
            .unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(read(path.to_str().unwrap(), None).unwrap(), bytes);
        assert_eq!(read("工作区 截图.png", dir.path().to_str()).unwrap(), bytes);
        assert!(read("工作区 截图.png", None).is_err());
        assert!(read("工作区 截图.png", Some("relative")).is_err());
    }

    #[test]
    fn rejects_missing_invalid_and_oversized_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("not-image.png");
        assert!(read(path.to_str().unwrap(), None).is_err());
        std::fs::write(&path, b"not an image").unwrap();
        assert!(read(path.to_str().unwrap(), None).is_err());
        std::fs::write(&path, b"<svg xmlns='http://www.w3.org/2000/svg'></svg>").unwrap();
        assert!(read(path.to_str().unwrap(), None).is_err());
        File::create(&path)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        assert!(read(path.to_str().unwrap(), None)
            .unwrap_err()
            .contains("20 MiB"));
        assert!(read(dir.path().to_str().unwrap(), None).is_err());
    }
}
