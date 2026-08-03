# Synthetic fixture

`one-second-avc.mp4` is generated video, not Tesla/user footage.

```sh
ffmpeg -f lavfi -i 'color=c=black:s=160x90:d=1:r=1' \
  -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart one-second-avc.mp4
```
