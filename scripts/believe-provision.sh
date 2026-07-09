#!/bin/bash
# believe: onboarding de un miembro del equipo para Rowboat Believe (Brain Client).
# Uso:
#   ./believe-provision.sh --brain-token mc_xxx --anthropic-key sk-ant-xxx [--mm-token xxx] [--deepgram-key xxx] [--workdir ~/.rowboat]
# Escribe las configs BYOK + Company Brain y habilita las fuentes. Idempotente.
set -euo pipefail

WORKDIR="${HOME}/.rowboat"
BRAIN_TOKEN="" ANTHROPIC_KEY="" MM_TOKEN="" DEEPGRAM_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --brain-token)   BRAIN_TOKEN="$2"; shift 2;;
    --anthropic-key) ANTHROPIC_KEY="$2"; shift 2;;
    --mm-token)      MM_TOKEN="$2"; shift 2;;
    --deepgram-key)  DEEPGRAM_KEY="$2"; shift 2;;
    --workdir)       WORKDIR="$2"; shift 2;;
    *) echo "arg desconocido: $1"; exit 1;;
  esac
done
[ -n "$BRAIN_TOKEN" ] || { echo "falta --brain-token (pídelo a Jorge)"; exit 1; }
[ -n "$ANTHROPIC_KEY" ] || { echo "falta --anthropic-key (pídela a Jorge)"; exit 1; }

CFG="$WORKDIR/config"
mkdir -p "$CFG"

python3 - "$CFG" "$BRAIN_TOKEN" "$ANTHROPIC_KEY" "$MM_TOKEN" "$DEEPGRAM_KEY" <<'EOF'
import json, os, sys
cfg, brain_token, anthropic_key, mm_token, dg_key = sys.argv[1:6]

def write(name, data, merge=False):
    p = os.path.join(cfg, name)
    if merge and os.path.exists(p):
        try:
            cur = json.load(open(p)); cur.update(data); data = cur
        except Exception: pass
    json.dump(data, open(p, "w"), indent=2)
    os.chmod(p, 0o600)
    print(f"  ✓ {name}")

write("company_brain.json", {
    "apiUrl": "https://vyllsxqkfefijdbqfgop.supabase.co/functions/v1",
    "apiKey": brain_token, "enabled": True,
    "pullIntervalMs": 60000, "pushIntervalMs": 120000,
}, merge=True)  # merge preserva deviceId si ya existe

write("models.json", {
    "provider": {"flavor": "anthropic", "apiKey": anthropic_key},
    "model": "claude-sonnet-5",
    "providers": {"anthropic": {"apiKey": anthropic_key}},
    "defaultSelection": {"provider": "anthropic", "model": "claude-sonnet-5"},
    "knowledgeGraphModel": {"provider": "anthropic", "model": "claude-haiku-4-5-20251001"},
    "meetingNotesModel": {"provider": "anthropic", "model": "claude-sonnet-5"},
})

if mm_token:
    write("mattermost.json", {
        "url": "https://chat.believe-global.com", "token": mm_token,
        "teamName": "believe",
        "channels": ["dev-team", "believe-team", "contenido", "socialmedia", "town-square"],
    })

if dg_key:
    write("deepgram.json", {"apiKey": dg_key})

# idioma de las notas del grafo
write("note_creation.json", {"language": "Spanish"}, merge=True)

# habilitar fuentes company_brain (+ mattermost si hay token)
ks_path = os.path.join(cfg, "knowledge_sources.json")
ks = {"sources": []}
if os.path.exists(ks_path):
    try: ks = json.load(open(ks_path))
    except Exception: pass
providers = {s.get("provider"): s for s in ks.get("sources", [])}
def ensure(provider, enabled):
    if provider in providers:
        providers[provider]["enabled"] = enabled
    else:
        ks.setdefault("sources", []).append({
            "id": provider.replace("_", "-"), "provider": provider, "enabled": enabled,
            "artifactDir": f"knowledge_sources/{provider}", "syncMode": "poll", "scopes": [],
        })
ensure("company_brain", True)
ensure("mattermost", bool(mm_token))
json.dump(ks, open(ks_path, "w"), indent=2)
print("  ✓ knowledge_sources.json (company_brain habilitado)")
EOF

echo ""
echo "Listo. Abre la app Rowboat Believe: el Company Brain se sincroniza solo."
echo "Gmail/Calendar: conéctalos desde la app (Settings → Google, client de Believe)."
