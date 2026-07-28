#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="ResearchAssistant"
APP_PATH="$SCRIPT_DIR/$APP_NAME.app"
SERVER_DIR="/Users/jiwonlee/research-assistant"
PORT=8321

echo "=== Research Assistant Dock 바로가기 빌드 ==="
echo ""

# 1. 기존 .app 제거
if [ -d "$APP_PATH" ]; then
    rm -rf "$APP_PATH"
fi

# 2. 번들 디렉토리 구성
mkdir -p "$APP_PATH/Contents/MacOS"
mkdir -p "$APP_PATH/Contents/Resources"

# 3. Info.plist
cat > "$APP_PATH/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>ResearchAssistant</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>com.baelab.research-assistant</string>
  <key>CFBundleName</key>
  <string>Research Assistant</string>
  <key>CFBundleDisplayName</key>
  <string>Research Assistant</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

# 4. 런처 실행 스크립트
cat > "$APP_PATH/Contents/MacOS/ResearchAssistant" << LAUNCHER
#!/bin/bash
PORT=$PORT
SERVER_DIR="$SERVER_DIR"
PYTHON="/Users/jiwonlee/micromamba/envs/main/bin/python3"

# GUI(.app)는 셸 PATH를 상속받지 못한다. claude CLI와 보조 도구(git 등) 경로 보강.
export PATH="\$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"

# 서버가 이미 실행 중인지 확인
if ! lsof -i :\$PORT -sTCP:LISTEN -t > /dev/null 2>&1; then
    # 서버 시작 (백그라운드, 새 터미널 없이)
    cd "\$SERVER_DIR"
    nohup "\$PYTHON" server.py > "\$SERVER_DIR/launcher.log" 2>&1 &

    # 서버 준비 대기 (최대 8초)
    for i in \$(seq 1 16); do
        sleep 0.5
        if lsof -i :\$PORT -sTCP:LISTEN -t > /dev/null 2>&1; then
            break
        fi
    done
fi

# 브라우저 오픈
open "http://localhost:\$PORT"
LAUNCHER

chmod +x "$APP_PATH/Contents/MacOS/ResearchAssistant"

# 5. 아이콘 생성
echo "  아이콘 생성 중..."
cd "$SCRIPT_DIR"
python3 make_icon.py

# 6. iconset → .icns 변환
echo "  .icns 변환 중..."
iconutil -c icns "$SCRIPT_DIR/AppIcon.iconset" -o "$APP_PATH/Contents/Resources/AppIcon.icns"

# 7. iconset 임시 폴더 정리
rm -rf "$SCRIPT_DIR/AppIcon.iconset"

# 8. Gatekeeper 서명 없이 실행 가능하도록 설정
xattr -cr "$APP_PATH" 2>/dev/null || true

echo ""
echo "✓ 빌드 완료: $APP_PATH"
echo ""
echo "사용 방법:"
echo "  1. Finder에서 $APP_PATH 를 Dock으로 드래그"
echo "  2. 또는 /Applications 에 복사 후 Dock에 추가"
echo ""
echo "  처음 실행 시 '확인되지 않은 개발자' 경고가 뜨면:"
echo "  Control+클릭 → 열기 → 열기 를 선택하세요."
