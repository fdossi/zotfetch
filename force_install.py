"""Legacy entry point kept to prevent direct edits to Zotero profiles.

Build an XPI with build.py and install it through Zotero's Add-ons UI in a
separate development profile. This command never discovers or changes a profile.
"""


def main():
    print(
        "Direct profile installation is disabled. Run 'python build.py', then "
        "install the XPI through Tools > Add-ons in a separate Zotero profile."
    )
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
