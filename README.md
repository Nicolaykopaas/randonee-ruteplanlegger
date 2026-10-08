# randonee-ruteplanlegger

Kartapp for toppturer på ski i Romsdal. Rutene er beregnet ut fra høydedata og bratthet i stedet for å være tegnet for hånd, og appen samler skredvarsel, vær og nøkkeltall for hver tur.

**Appen:** https://experience.arcgis.com/experience/6556e9d6567a4642b438cd32fdf19e4c
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

## Hvordan rutene beregnes

1. Terrengmodell (DTM) fra Kartverket.
2. Kostnadsflate ut fra bratthet – celler over 30° sperres.
3. Minste-kostnad-rute fra startpunkt til topp.
4. Nøkkeltall (km, høydemeter, eksponert terreng) og nivå per rute.
5. Publisert som hosted feature layer, webkart og Experience Builder-app i ArcGIS Online.

## Filer

- forhold.html – live forholdsside (skredvarsel, vær på toppene, siste turrapporter)
- banner.html – kompakt skredvarselbanner for innbygging i appen

## Ansvarsfraskrivelse

Rutene er beregnet automatisk med en grense på 30° og er ikke kvalitetssikret. Bruk skjer på eget ansvar. Sjekk alltid skredvarselet på [varsom.no](https://varsom.no) og gjør egne vurderinger i terrenget.

## Laget av

Nicolay Øien Kopaas, sivilingeniørstudent i Ingeniørvitenskap og IKT ved NTNU.
