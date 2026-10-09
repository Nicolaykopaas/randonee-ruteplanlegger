# randonee-ruteplanlegger

Kartapp for toppturer på ski i Romsdal. Rutene er beregnet ut fra høydedata og bratthet i stedet for å være tegnet for hånd, og appen samler skredvarsel, vær og nøkkeltall for hver tur.

**Ny 3D-app (Night Summit):** https://nicolaykopaas.github.io/randonee-ruteplanlegger/app/
**Experience Builder-appen:** https://experience.arcgis.com/experience/6556e9d6567a4642b438cd32fdf19e4c
**Forhold i Romsdal (live skredvarsel + vær på toppene):** https://nicolaykopaas.github.io/randonee-ruteplanlegger/forhold.html

## Funksjoner

- Filtrer på maks km, maks høydemeter og nivå (Lett, Middels, Krevende)
- Rutetabell med zoom til valgt tur og høydeprofil
- Popup med nøkkeltall, estimert tid (Munter-metoden) og himmelretning på nedkjøringen med føretips
- Parkering og startpunkt med «Naviger hit» og lenke til været på toppen (yr.no)
- Dagens skredfaregrad (NVE Varsom API) og vær på alle 34 toppene (MET Locationforecast), hentet live
- Turrapporter fra brukere (Survey123)
- Velkomstside, Min posisjon, deling og mobiltilpasset layout

## Datakilder

| Kilde | Brukes til |
|---|---|
| Kartverket, høydedata (DTM) | Terrengmodell for ruteberegning og høydeprofil |
| NVE, bratthet og skredterreng | Bratthet og eksponert terreng |
| NVE Varsom API | Skredfaregrad |
| MET Locationforecast 2.0 | Værvarsel på toppene |
| Geodata (Geocache UTM33) | Flyfoto og terreng i 3D-appen |

## Hvordan rutene beregnes

1. Terrengmodell (DTM) fra Kartverket.
2. Kostnadsflate ut fra bratthet – celler over 30° sperres.
3. Minste-kostnad-rute fra startpunkt til topp.
4. Nøkkeltall (km, høydemeter, eksponert terreng) og nivå per rute.
5. Publisert som hosted feature layer, webkart og Experience Builder-app i ArcGIS Online.

## 3D-appen (/app)

Statisk webapp bygget med ArcGIS Maps SDK for JavaScript 4.31 fra CDN, vanilla JS/HTML/CSS og uten build-steg. Alle tjenestene er offentlige, så den trenger verken innlogging eller nøkler.

- Åpner i 3D (lokal scene i EPSG:25833 med flyfoto og terreng fra Geodata). Du kan bytte til 2D, og filter og valgt tur beholdes.
- Selvlysende ruter i nivåfarger. Valgt rute pulserer.
- Skredfare-ring med faregrad for i dag og de neste to dagene (NVE Varsom, Romsdal).
- «Finn tur»: maks km, maks høydemeter og nivå. Kart og liste oppdateres med en gang.
- Turkort med nøkkeltall, himmelretning og føretips, eksponeringsvarsel, høydeprofil (sampla fra terrenget), «Fly over ruta», «Naviger hit», «Vær på toppen» og deling (`?tur=id`).
- Forhold-fanen viser vær på alle toppene (MET), «Best i dag» og de siste turrapportene.
- Lys og mørk modus, Min posisjon, bratthet av/på og tegnforklaring.
- Mobil: bunnark med tre høyder. Appen faller tilbake til 2D på svake enheter.

Struktur: `app/index.html`, `app/js/config.js` (felles state og hendelser), `app/js/app.js` (oppstart og datahenting), og én modul per del: `scene`, `panel`, `card`, `flyover`, `forhold` og `mobile`. Hver modul har sin egen CSS i `app/css/`, og `theme.css` inneholder designsystemet.

Lokalt: `npx http-server .` i rotmappa, og åpne `/app/`. Med `?mode=2d` eller `?mode=3d` tvinger du visningen.

## Filer

- app/ – 3D-ruteplanleggeren (se over)
- forhold.html – live forholdsside (skredvarsel, vær på toppene, siste turrapporter)
- banner.html – kompakt skredvarselbanner for innbygging i appen

## Ansvarsfraskrivelse

Rutene er beregnet automatisk med en grense på 30° og er ikke kvalitetssikret. Bruk skjer på eget ansvar. Sjekk alltid skredvarselet på [varsom.no](https://varsom.no) og gjør egne vurderinger i terrenget.

## Laget av

Nicolay Øien Kopaas, sivilingeniørstudent i Ingeniørvitenskap og IKT ved NTNU.
