"""Compatibility entry point; use package_plugins.py for either assistant."""

from package_plugins import build, main, validate_repo, write_archive


if __name__ == "__main__":
    main()
