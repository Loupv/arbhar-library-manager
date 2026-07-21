# arbhar — unofficial library manager

A lightweight sample-library manager for the **Instruō arbhar** granular module
(Firmware 2.0). A tiny local Node server serves a dark/gold browser UI and edits the real
files on disk (the arbhar's USB drive, or a local folder). Zero dependencies, no build step.

> **Unofficial project** — not affiliated with, endorsed by, or supported by Instruō.
> "arbhar" and "Instruō" are trademarks of Instruō Ltd. No Instruō sample content or
> documentation is included here.

### Download
Grab a ready-to-run executable for macOS or Windows from the
[**Releases**](../../releases) page — no Node.js required. First-launch notes (unsigned
binaries) and build instructions are in [BUILD.md](BUILD.md).

### Run from source
Requires [Node.js](https://nodejs.org) 18+.

```bash
cd arbhar-library-editor
npm start          # or: node server.js
```

The browser opens at `http://localhost:4173` (change with `PORT=5000 npm start`).
On macOS you can also double-click `arbhar-library-editor.command`.

### License
[MIT](LICENSE) © Loup Vuarnesson.

---

## (FR) Lancer

```bash
cd arbhar-library-editor
npm start          # ou: node server.js
```

Le navigateur s'ouvre sur `http://localhost:4173`. (Port : `PORT=5000 npm start`.)

## Utilisation

1. **Choisir la racine** — au démarrage, navigue jusqu'au dossier racine de ta librairie
   (la clé USB montée dans `/Volumes/…`, ou un dossier `arbhar-sample-library`).
   Le losange ◆ signale une structure arbhar détectée.
   Coche *« Créer la structure complète »* pour initialiser une clé vierge
   (6 librairies × 36 slots + les 36 scenes).
   Le **dernier dossier ouvert est mémorisé** (dans `.config.json`) et rouvert
   automatiquement au démarrage suivant ; si le chemin n'existe plus (clé débranchée),
   le sélecteur réapparaît. Le bouton *« Changer »* en haut permet d'en choisir un autre.
   Si tu pointes par erreur le dossier `_arbhar_library` lui-même, la racine est
   corrigée automatiquement vers son parent.

2. **Naviguer**
   - **Library 1…6** : grille 6×6 = `bank` (lignes) × `layer` (colonnes), convention `#_#`.
     Un point or = slot rempli. L'inspecteur à droite liste les fichiers du slot.
   - **Scenes** : sélecteurs `Bank` (1-6) + `Scene` (1-6) en haut, puis les **6 layers**
     de la scene choisie en sous-grille (une tuile par layer). Pas de liste à droite.

3. **Écouter & éditer** — clique un slot / une tuile de layer pour l'écouter directement.
   Lecteur persistant en bas (barre de progression cliquable). Badge vert = format idéal
   48 kHz / 24 bit. La lecture **s'arrête automatiquement** quand on quitte l'écran, change
   d'onglet, ou change de bank/scene. Le panneau **Éditeur** (à droite) affiche la **forme
   d'onde** du sample : glisse les bords pour **rogner**, règle les **fondus in/out**, coche
   **Normalize** pour normaliser le pic à un niveau dB cible (paramètre **global**, mémorisé),
   écoute la sélection, puis **Apply** réécrit le fichier en 24-bit 48 kHz. Tout est
   réversible (toast **Undo**, l'original part à la corbeille). Marche pour library et scenes.
   **Raccourcis clavier** : `↑ ↓ ← →` naviguer (et écouter au passage — la grille en
   library, les 6 layers en scenes), `Tab` / `Shift+Tab` changer d'onglet, `espace` play/pause.

4. **Nommer** — ✎ sur un fichier / une tuile. Le préfixe numérique de chargement
   (`1_`, `2_`…) est conservé ; tu ne changes que le nom lisible.

5. **Drag & drop**
   - **Depuis le Finder → un slot / une tuile de layer** : dépose un `.wav`, il **remplace**
     directement le contenu du slot / layer (pas d'étape par la liste de droite).
   - **Depuis le Finder → la Réserve** : dépose des `.wav` **ou un dossier entier** (la
     structure du dossier est recréée dans la réserve). Seuls les fichiers audio sont importés.
   - **Réserve → slot / layer** : glisse une entrée de la réserve (copie côté serveur).
   - **Slot / layer → Réserve** : glisse un sample existant de la library ou d'une scene
     dans la réserve (ou dans un de ses dossiers) pour le **collectionner et le réordonner**.
     C'est une **copie** — la library/scene d'origine n'est jamais modifiée. Le préfixe de
     chargement est retiré ; tu peux ensuite le renommer, le ranger, puis le re-glisser
     dans les slots de ton choix.

   **Réserve avec dossiers (arborescence)** : crée des dossiers (`＋ folder`, ou `＋` sur un
   dossier pour un sous-dossier), **clique un dossier pour le déplier en place** (accordéon —
   le reste de la liste reste visible), **déplace** un sample/dossier en le glissant sur un
   autre dossier, et **réordonne manuellement** avec les flèches ▲▼ (au survol, ordre
   persistant). **Toute la zone Réserve** est droppable : déposer sur un dossier = dedans,
   ailleurs = à la racine. Croix discrète au survol pour retirer (vers la corbeille).
   L'app est en **anglais**.

6. **Supprimer** — le petit **✕** en haut d'une tuile (pad / layer) vide le slot
   directement, **sans confirmation** ; un toast **Undo** permet d'annuler. Aucune boîte
   de dialogue de confirmation nulle part — tout repose sur l'Undo + la corbeille
   `arbhar-library-editor/.trash/` (jamais de suppression définitive).

## Format arbhar respecté

- Racine : `_arbhar_library`, `_arbhar_library_2..6`, `_arbhar_scenes`.
- Librairie : 36 sous-dossiers `#_#_sample` (bank 1-6 × layer 1-6), 1+ `.wav` par slot.
- Scene : 36 sous-dossiers `#_#_scene`, jusqu'à 6 `.wav` + un `preset.txt` (préservé).
- Nommage `N_Nom.wav` — `N` = index de chargement dans le slot.
- Formats acceptés : `.wav`, `.aif`, `.aiff` (l'arbhar convertit les autres taux ;
  cible idéale 48 kHz / 24 bit). Aucune conversion automatique n'est faite ici.

## Notes

- Outil mono-utilisateur, en local uniquement (localhost). Rien n'est envoyé sur le réseau.
- Les `preset.txt` des scenes ne sont pas modifiés — seuls les samples sont gérés.
- Travaille de préférence sur une **copie** de ta librairie avant de manipuler la clé finale.
