import zipfile
import os
import json
import argparse
import glob


def get_version_from_manifest(manifest_path="manifest.json"):
    if not os.path.exists(manifest_path):
        raise FileNotFoundError(f"Arquivo {manifest_path} não encontrado.")

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    version = (manifest.get("version") or "").strip()
    if not version:
        raise ValueError("Campo 'version' ausente ou vazio em manifest.json.")

    return version

def build_archive(output_filename, files_to_include):
    if os.path.exists(output_filename):
        os.remove(output_filename)

    with zipfile.ZipFile(output_filename, 'w', zipfile.ZIP_DEFLATED) as xpi:
        for file in files_to_include:
            if os.path.exists(file):
                xpi.write(file)
                print(f"Adicionado: {file}")
            else:
                raise FileNotFoundError(f"Arquivo {file} não encontrado!")

    print(f"\nSucesso! Arquivo '{output_filename}' criado na pasta.")


def clean_old_xpis(pattern="zotfetch*.xpi"):
    removed = 0
    for file in glob.glob(pattern):
        if os.path.isfile(file):
            os.remove(file)
            removed += 1

    print(f"Limpeza concluída: {removed} arquivo(s) removido(s).")


def create_xpi(with_latest=False, clean=False):
    files_to_include = [
        'manifest.json',
        'bootstrap.js',
        'prefs.js',
        'chrome/content/utils.mjs',
        'chrome/content/prefs.mjs',
        'chrome/content/cooldown.mjs',
        'chrome/content/identifiers.mjs',
        'chrome/content/source-resolvers.mjs',
        'chrome/content/pdf-resolvers.mjs',
        'chrome/content/importer.mjs',
        'chrome/content/fetch.mjs',
        'chrome/content/ui.mjs',
        'locale/en-US/zotfetch.ftl'
    ]
    version = get_version_from_manifest()
    versioned_filename = f'zotfetch-{version}.xpi'

    if clean:
        clean_old_xpis()

    build_archive(versioned_filename, files_to_include)

    if with_latest:
        latest_filename = 'zotfetch.xpi'
        build_archive(latest_filename, files_to_include)
        print(f"Também gerado alias latest: '{latest_filename}'.")

    print("Agora instale este arquivo no Zotero.")


def parse_args():
    parser = argparse.ArgumentParser(description="Gera pacote XPI do plugin Zotero.")
    parser.add_argument(
        "--with-latest",
        action="store_true",
        help="Gera também zotfetch.xpi (alias latest) além do arquivo versionado"
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove arquivos antigos zotfetch*.xpi antes de gerar os novos"
    )
    return parser.parse_args()

if __name__ == "__main__":
    args = parse_args()
    create_xpi(with_latest=args.with_latest, clean=args.clean)