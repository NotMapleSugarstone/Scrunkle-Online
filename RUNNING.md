# Running the local build

This folder is the complete TypeScript port from `MapleSugarstone/Scrunkle-Online`, with the full 107 MB asset set and the existing rollback netcode source.

## Start it

```sh
./run.sh
```

or:

```sh
npm start
```

Then open <http://127.0.0.1:8782/>.

`run.sh` tries to open the page in the desktop browser as well. Keep the terminal open while playing; press Ctrl+C to stop the server.

The game is served from `dist/`, so `file://` is not used. ES modules and the asset tree do not work reliably from `file://`.

## First load

The page fetches the collision masks and whatever the lobby itself draws. **Play offline** is enabled as soon as the masks are ready. Leaving the lobby loads the shared menu, selection and stage art plus the short sounds; cards, shop, awards, cutscene and other mode-specific art load when their screen first draws them, the two selected fighters and their effects load when they are picked, and music loads when a match starts. Cutscenes are disabled by default; enable them in Settings if you want them, though their art still loads on demand. Depending on the connection, an asset outside those groups can briefly show a placeholder while it arrives, but the game never waits for the full asset set. The browser can reuse the files after the first load, but the game still prepares its textures each time.

If the page has to be rebuilt, run:

```sh
RELAY_URL=https://scrunkle-rooms.maplesugarstone.workers.dev npm run build
```

## Controls

The defaults are arrows to move, **N** to attack/select, **M** for special/back, **B** to shield and **V** to pause. **Controls** on the start screen changes them.

## Online

The rollback netcode and room client are present in `src/net/` and `src/client/online.ts`. This build uses the public relay:

```sh
RELAY_URL=https://scrunkle-rooms.maplesugarstone.workers.dev npm run build
```

The room server lives in `server/`; see the repository README for `npm run worker:dev` and deployment. The relay currently accepts browser origins `https://maplesugarstone.github.io` and localhost. Offline play works from any origin; online play from another GitHub Pages account needs the relay's `ALLOWED_ORIGINS` updated or a different relay.

## Original files

The original Turbowarp build in the parent folder and the built copy in `srt netcode/` were left untouched. This game runs from `srt-web/dist/`.
