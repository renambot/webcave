# Dot-density data

Legend summaries (`summary-<field>.csv`, percentages per category) and place
labels (`placeLabels.json`) from the School of Cities' Toronto 2021 dot-density
map, <https://schoolofcities.github.io/dot-density/> (University of Toronto).
The dots themselves, about 278,000 rows of `pp-to-10m-income-edit-3.csv`
(23 MB), are fetched from that site at run time; set the app's `data` option
to a local copy for an installation without internet access.

Source data: Statistics Canada, Census of Population 2021, one dot per ten
people, placed within dissemination areas by the School of Cities. Used here
for the WebCAVE port of the visualization (`src/apps/dotdensity/`); the data
and design are theirs.
