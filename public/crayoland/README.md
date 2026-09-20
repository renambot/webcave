# Crayoland data

Crayoland is by Dave Pape (Electronic Visualization Laboratory, University of
Illinois at Chicago, 1995), the first application written for the CAVE and its
long-running demo. These are the data files of the OpenGL/Bergen version of
the program (CAVElib 2.7 era): the `World` scene description, the `Sounds`
description, the crayon drawings in `tex/`, the footfall ground masks
(`map.lake.png`, `map.floor.png`), and the two hand models. The AIFF sounds
were converted to MP3 for the browser and the SGI `.bw` masks to PNG; `Sounds`
and the hive line of `World` name the converted files, and `Sounds` points its
`directory` at `audio/`. Everything else is as it was.

The port lives in `src/apps/crayoland/`. Crayoland's artwork and code are
Dave Pape's and EVL's; they are included here for the port and are not
covered by this repository's BSD license.

Original: <https://www.evl.uic.edu/pape/projects/crayoland/>
