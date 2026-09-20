# Volumes

OpenVDB files for the `vdb` application. Served at `/volumes/<name>.vdb`.

- `smoke2.vdb` — a Houdini smoke simulation (float grid `density`, 191×610×178
  voxels at 0.1 m, plus a velocity grid `v`), 29 MB. Local sample, not
  redistributed.
- `waterfall_points.vdb` — a Houdini particle simulation as an OpenVDB
  PointDataGrid (`points`: 9.5 M points with P, Cd, id, v; 0.05 m voxels),
  157 MB. Local sample, not redistributed. Used by the `points` app.
