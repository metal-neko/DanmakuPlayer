pub fn fit(
    width: f64,
    height: f64,
    available_width: f64,
    available_height: f64,
) -> Option<(u32, u32)> {
    if [width, height, available_width, available_height]
        .iter()
        .any(|v| !v.is_finite() || *v <= 0.0)
    {
        return None;
    }
    let maximum = (available_width / width).min(available_height / height);
    let minimum = (320.0 / width).max(240.0 / height);
    let scale = maximum.min(maximum.min(1.0).max(minimum));
    Some((
        (width * scale).floor().max(1.0) as u32,
        (height * scale).floor().max(1.0) as u32,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fits_video_to_available_area() {
        assert_eq!(fit(1280.0, 720.0, 1920.0, 1080.0), Some((1280, 720)));
        assert_eq!(fit(320.0, 180.0, 1920.0, 1080.0), Some((426, 240)));
        assert_eq!(fit(0.0, 720.0, 1920.0, 1080.0), None);
        let (width, height) = fit(3840.0, 2160.0, 1904.0, 1040.0).unwrap();
        assert!(width <= 1904 && height <= 1040);
        assert!((width as f64 * 2160.0 - height as f64 * 3840.0).abs() < 2160.0);
    }
}
