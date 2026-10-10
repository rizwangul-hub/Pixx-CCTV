# Camera & DVR Configuration Guide

## 1. DVR/NVR RTSP Stream Configuration

CCTV / DVR se video feed access karne ke liye RTSP (Real-Time Streaming Protocol) URL ka use kiya jata hai.

### Standard RTSP Format:
```text
rtsp://<username>:<password>@<dvr-ip-address>:<port>/Streaming/Channels/<channel-number>
```

### Example URL Patterns (Use your own credentials):
- **Hikvision**: `rtsp://<username>:<password>@<dvr-ip>:554/Streaming/Channels/101`
- **Dahua**: `rtsp://<username>:<password>@<dvr-ip>:554/cam/realmonitor?channel=1&subtype=0`
- **CP PLUS**: `rtsp://<username>:<password>@<dvr-ip>:554/cam/realmonitor?channel=1&subtype=0`

---

## 2. Network Setup
1. DVR aur camera-agent run karne wale device ko same local network (LAN / Subnet) me connect karein.
2. DVR ko static IP assign karein taaki IP change na ho.
3. Port 554 (RTSP default) firewall me allow hona chahiye.
