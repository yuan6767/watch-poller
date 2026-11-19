#!/bin/bash
# 拿到 GitHub token 后一键：建仓库 → 推代码 → 配 secrets → 触发连通性测试
set -e
TOKEN="$(cat /home/user/jzlocal-work/.gh_token)"
REPO_DIR="/home/user/Doubao/chats/38447748627671554/gh-watch-poll"
API="https://api.github.com"
H_AUTH="Authorization: Bearer $TOKEN"
H_ACC="Accept: application/vnd.github+json"

echo "── 1. 确认账号 ──"
LOGIN=$(curl -s -H "$H_AUTH" -H "$H_ACC" $API/user | python3 -c "import sys,json;print(json.load(sys.stdin)['login'])")
echo "   账号: $LOGIN"

REPO="watch-poller"
echo "── 2. 建仓库 $LOGIN/$REPO（public） ──"
CODE=$(curl -s -o /tmp/mk.json -w "%{http_code}" -X POST -H "$H_AUTH" -H "$H_ACC" \
  -d "{\"name\":\"$REPO\",\"description\":\"手表 AI 云端兜底轮询\",\"private\":false,\"auto_init\":false}" \
  $API/user/repos)
echo "   HTTP $CODE $(head -c 200 /tmp/mk.json)"
FULL="$LOGIN/$REPO"

echo "── 3. 初始化本地仓库并推送 ──"
cd "$REPO_DIR"
git init -q 2>/dev/null || true
git config user.name "$LOGIN"
git config user.email "$LOGIN@users.noreply.github.com"
git checkout -q -B main 2>/dev/null || true
printf 'state.json\nnode_modules/\n' > .gitignore
git add -A
git commit -q -m "init: 手表 AI 云端兜底轮询" || echo "   （无改动可提交）"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:$TOKEN@github.com/$FULL.git"
git push -u origin main --force 2>&1 | tail -3

echo "── 4. 配 Secrets ──"
export GH_TOKEN="$TOKEN"
gh secret set IM_CONFIG_JSON -R "$FULL" -b "$(cat /home/user/jzlocal-work/.im_config.json)" && echo "   ✅ IM_CONFIG_JSON"
gh secret set ZHIPU_KEY -R "$FULL" -b "292400f5c1c14ef6a02ccf7510c8eab5.z6wwS9YJOv9O0HPr" && echo "   ✅ ZHIPU_KEY"

echo "── 5. 触发连通性测试 ──"
sleep 3
gh workflow run net-check.yml -R "$FULL" 2>&1 | tail -2 || echo "   触发失败，可能 workflow 还没被 GitHub 识别"
echo
echo "仓库地址: https://github.com/$FULL"
