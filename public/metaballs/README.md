# WebGPU Metaballs

The "Metaballs" entry of the WebGPU Samples points at Brandon Jones's
webgpu-metaballs (<https://github.com/toji/webgpu-metaballs>, MIT). WebCAVE's
port keeps its source in `src/apps/metaballs/vendor/` (two lines changed, see
that folder's index.ts) and drives it from the CAVE's cameras.

`wtt/` holds the prebuilt web-texture-tool loader and its Basis and KTX
transcoder workers (Brandon Jones, MIT, `wtt/LICENSE.md`), which decode the
scene's KTX2 textures.

The media, the dungeon glTF scene and the lava, water and slime textures, are
fetched at run time from <https://toji.github.io/webgpu-metaballs/media/> and
are not part of this repository: the dungeon model was purchased on Sketchfab
under its Standard License, the door is CC BY 4.0, the lava textures are from
ArtStation (see the ATTRIBUTION.md files in that project). Point the app's
`model` option at a local copy for an installation without internet access.
