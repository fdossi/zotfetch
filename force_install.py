"""
Force-installs zotfetch@edslab.research into the active Zotero profile
by directly editing extensions.json and placing the XPI in extensions/.
Run with Zotero CLOSED.
"""

import json
import os
import shutil
import time
import uuid

ADDON_ID       = "zotfetch@edslab.research"
PROFILE_DIR    = os.path.expandvars(r"%APPDATA%\Zotero\Zotero\Profiles\l1536wh8.default")
EXT_DIR        = os.path.join(PROFILE_DIR, "extensions")
XPI_DST        = os.path.join(EXT_DIR, ADDON_ID + ".xpi")
EXT_JSON       = os.path.join(PROFILE_DIR, "extensions.json")
PREFS_JS       = os.path.join(PROFILE_DIR, "prefs.js")
STARTUP_CACHE  = os.path.join(PROFILE_DIR, "addonStartup.json.lz4")


def load_manifest():
    manifest_path = os.path.join(os.path.dirname(__file__), "manifest.json")
    with open(manifest_path, "r", encoding="utf-8") as f:
        return json.load(f)


MANIFEST = load_manifest()
VERSION = (MANIFEST.get("version") or "").strip() or "1.0.0"
XPI_SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), f"zotfetch-{VERSION}.xpi"))


def check_zotero_closed():
    import subprocess
    result = subprocess.run(
        ["powershell", "-Command", "Get-Process zotero -ErrorAction SilentlyContinue"],
        capture_output=True, text=True
    )
    if result.stdout.strip():
        print("ERRO: O Zotero está aberto. Feche o Zotero antes de executar este script.")
        return False
    return True


def backup(path):
    bak = path + ".bak-force-install"
    shutil.copy2(path, bak)
    print(f"Backup: {bak}")


def build_addon_entry():
    now_ms = int(time.time() * 1000)
    root_uri = "jar:file:///" + XPI_DST.replace("\\", "/").lstrip("/") + "!/"
    zotero_app = MANIFEST.get("applications", {}).get("zotero", {})
    min_version = zotero_app.get("strict_min_version", "8.0.4")
    max_version = zotero_app.get("strict_max_version", "8.*")
    description = MANIFEST.get("description", "Download batch de PDFs via DOI para Zotero 8.")
    author = MANIFEST.get("author", "Fabio")
    return {
        "id": ADDON_ID,
        "syncGUID": "{" + str(uuid.uuid4()) + "}",
        "version": VERSION,
        "type": "extension",
        "loader": None,
        "updateURL": None,
        "installOrigins": None,
        "manifestVersion": 2,
        "optionsURL": None,
        "optionsType": None,
        "optionsBrowserStyle": True,
        "aboutURL": None,
        "defaultLocale": {
            "name": "ZotFetch",
            "description": description,
            "creator": author,
            "developers": None,
            "translators": None,
            "contributors": None
        },
        "visible": True,
        "active": True,
        "userDisabled": False,
        "appDisabled": False,
        "embedderDisabled": False,
        "installDate": now_ms,
        "updateDate": now_ms,
        "applyBackgroundUpdates": 1,
        "path": XPI_DST,
        "skinnable": False,
        "sourceURI": None,
        "releaseNotesURI": None,
        "softDisabled": False,
        "foreignInstall": False,
        "strictCompatibility": True,
        "locales": [],
        "targetApplications": [
            {"id": "zotero@zotero.org", "minVersion": min_version, "maxVersion": max_version}
        ],
        "targetPlatforms": [],
        "signedState": 0,
        "signedDate": None,
        "seen": True,
        "dependencies": [],
        "incognito": "spanning",
        "userPermissions": {"permissions": [], "origins": []},
        "optionalPermissions": {"permissions": [], "origins": []},
        "icons": {},
        "iconURL": None,
        "blocklistState": 0,
        "blocklistURL": None,
        "startupData": None,
        "hidden": False,
        "installTelemetryInfo": {"source": "about:addons", "method": "install-from-file"},
        "recommendationState": None,
        "rootURI": root_uri,
        "location": "app-profile"
    }


def copy_xpi():
    os.makedirs(EXT_DIR, exist_ok=True)
    if not os.path.exists(XPI_SRC):
        raise FileNotFoundError(f"XPI não encontrado: {XPI_SRC}")
    shutil.copy2(XPI_SRC, XPI_DST)
    print(f"XPI copiado: {XPI_DST}")


def remove_proxy_file():
    proxy = os.path.join(EXT_DIR, ADDON_ID)
    if os.path.isfile(proxy):
        os.remove(proxy)
        print(f"Proxy removido: {proxy}")
    unpacked_dir = proxy
    if os.path.isdir(unpacked_dir):
        shutil.rmtree(unpacked_dir)
        print(f"Pasta descompactada removida: {unpacked_dir}")


def patch_extensions_json():
    backup(EXT_JSON)
    with open(EXT_JSON, "r", encoding="utf-8") as f:
        data = json.load(f)

    addons = data.get("addons", [])
    addons = [a for a in addons if a.get("id") != ADDON_ID]
    addons.append(build_addon_entry())
    data["addons"] = addons

    with open(EXT_JSON, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"extensions.json atualizado ({len(addons)} add-ons registrados)")


def clear_prefs_cache():
    backup(PREFS_JS)
    with open(PREFS_JS, "r", encoding="utf-8") as f:
        lines = f.readlines()
    filtered = [l for l in lines
                if "extensions.lastAppBuildId" not in l
                and "extensions.lastAppVersion" not in l]
    with open(PREFS_JS, "w", encoding="utf-8") as f:
        f.writelines(filtered)
    print("prefs.js: chaves de cache removidas")


def remove_startup_cache():
    if os.path.exists(STARTUP_CACHE):
        os.remove(STARTUP_CACHE)
        print(f"Cache removido: {STARTUP_CACHE}")
    else:
        print("addonStartup.json.lz4 não encontrado (ok)")


def main():
    print("=== EDSLab Force Install ===\n")

    if not check_zotero_closed():
        return

    remove_proxy_file()
    copy_xpi()
    patch_extensions_json()
    clear_prefs_cache()
    remove_startup_cache()

    print("""
=== Instalação forçada concluída ===
Agora inicie o Zotero com:

  & "C:/Program Files/Zotero/zotero.exe" -purgecaches -ZoteroDebugText -jsconsole

Depois verifique Tools → Add-ons se 'ZotFetch' aparece.
""")


if __name__ == "__main__":
    main()
