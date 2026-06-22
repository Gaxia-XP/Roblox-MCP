# Multi-AI Blender Add-on

Bridges Blender to the Multi-AI Blender MCP server (`blender/server.mjs`, port 8766).

## Install (one time, per Blender version)
Run `..\..\sync-blender-addon.ps1` from the repo root — it copies `MultiAI_Blender.py`
into the `scripts/addons` folder of every detected Blender (4.5 and 5.0). Then in
each Blender: **Edit → Preferences → Add-ons → search "Multi-AI" → enable**.
The add-on auto-starts polling on enable and on every Blender launch thereafter.

## Verify
With `blender/server.mjs` running, call the `blender_get_connection_status` MCP tool —
it should return `{ "addonConnected": true, "ready": true }`.

## Versions
Tested on Blender 4.5 LTS and 5.0. Every bpy/bmesh API used is identical across both.
This is a legacy `bl_info` add-on (still supported on both, deprecated since 4.2).

## Optional: install as an Extension (future-proof)
Wrap this file in a folder with a `blender_manifest.toml`
(`schema_version="1.0.0"`, `id`, `version`, `name`, `tagline`, `maintainer`,
`type="add-on"`, `blender_version_min="4.5.0"`, `license=["SPDX:GPL-2.0-or-later"]`),
then **Preferences → Add-ons → Install from Disk** the zipped folder. Not required for v1.
