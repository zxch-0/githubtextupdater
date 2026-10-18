# Demander du code à une IA au format du tool

Le but : donner à n'importe quelle IA (ChatGPT, Claude, Gemini, une IA en ligne de commande…)
un prompt qui la force à répondre **directement** au format attendu par GitHub Text Updater,
pour n'avoir qu'à copier/coller sa réponse dans la zone de texte de l'étape 3.

* Le texte exact du prompt est dans **`public/ai-prompt.txt`** (source canonique).
* Dans l'outil, le bouton **« Copy AI prompt »** (étape 3) le met dans le presse-papier.

Mode d'emploi :

1. Copiez le prompt.
2. Remplissez les deux dernières sections (`CONTEXTE DE MON PROJET` et `MA DEMANDE`).
3. Collez le tout à l'IA.
4. Collez **sa réponse complète** (elle ne doit contenir que les blocs de code) dans l'outil.
5. Analysez → décochez ce qui ne vous va pas → Commit → Open PR → Merge.

---

## Le prompt

````markdown
Tu vas écrire du code pour mon dépôt GitHub.

Ta réponse doit contenir UNIQUEMENT le bloc de texte au format ci-dessous, sans aucune phrase
d'introduction, de conclusion ou d'explication : je vais coller ta réponse telle quelle dans un
outil qui crée/modifie les fichiers, ouvre une pull request et la merge.

FORMAT
------
Un bloc de code par fichier. Le chemin du fichier se trouve sur la ligne d'ouverture du bloc :

```<langage> path=<chemin/dans/le-depot> action=<action>
<contenu complet du fichier>
```

Exemple :

```python path=src/mathx/ops.py action=upsert
def add(a, b):
    return a + b
```

RÈGLES
------
1. `path=` est OBLIGATOIRE et relatif à la racine du dépôt (`src/lib/utils.ts`).
   Jamais de `/` au début, jamais de `../`, jamais de chemin absolu.
2. `action=` (optionnel, défaut `upsert`) :
   - `upsert`            : crée le fichier s'il n'existe pas, sinon remplace tout son contenu
   - `create`            : le fichier ne doit pas encore exister
   - `update`            : le fichier existe déjà et tu réécris tout son contenu
   - `append` / `prepend`: ajoute le bloc à la fin / au début du fichier existant
   - `patch`             : modifie un fichier existant avec un ou plusieurs blocs search/replace
   - `delete`            : supprime le fichier (le corps du bloc est ignoré)
3. Pour `action=patch`, le corps du bloc est :
     <<<<<<< SEARCH
     <les lignes EXACTES présentes dans le fichier, indentation comprise>
     =======
     <les nouvelles lignes>
     >>>>>>> REPLACE
   Le bloc SEARCH doit exister tel quel et n'apparaître qu'une seule fois, sinon l'outil refuse.
   Un bloc REPLACE vide supprime ces lignes. Plusieurs sections SEARCH/REPLACE peuvent s'enchaîner
   dans un même bloc.
4. Écris TOUJOURS le contenu COMPLET et fonctionnel de chaque fichier.
   Interdits : « ... », « // reste du code », « (inchangé) », tout placeholder.
5. Un fichier = un bloc. Aucun chemin en double. Aucun texte en dehors des blocs.
6. Optionnel, tout en haut de ta réponse, tu peux ajouter :
     ---
     pr_title: <titre de la pull request>
     pr_body: |
       <description en markdown>
     commit_message: <message de commit>
     ---
7. Options utiles sur la ligne d'ouverture : `exec` ou `mode=755` pour rendre un script exécutable.

CONTEXTE DE MON PROJET
----------------------
- Dépôt :
- Stack (langage, framework, versions) :
- Branche de base : main
- Arborescence / fichiers concernés :
- Contraintes (style, conventions, dépendances autorisées) :

MA DEMANDE
----------
- Objectif :
- Fichiers à créer :
- Fichiers existants à modifier, et ce qui doit changer :
- Comportement attendu / comment vérifier :

Réponds uniquement avec le bloc de texte au format demandé.
````

### Version courte (pour un dépôt que l'IA connaît déjà)

```markdown
Réponds uniquement avec un bloc de texte au format GitHub Text Updater :
un bloc de code délimité par ``` par fichier, avec `path=<chemin>` (obligatoire) et
`action=upsert|create|update|append|prepend|patch|delete` sur la ligne d'ouverture.
Contenu complet de chaque fichier, aucun placeholder, aucun texte hors des blocs.
Pour modifier un fichier existant, utilise `action=patch` avec des sections
`<<<<<<< SEARCH / ======= / >>>>>>> REPLACE`.
Demande : <votre demande>
```

---

## Exemple concret de demande remplie

```markdown
CONTEXTE DE MON PROJET
----------------------
- Dépôt : acme/dashboard
- Stack : Next.js 14 (App Router), TypeScript, Tailwind CSS, Jest
- Branche de base : main
- Arborescence : app/, components/, lib/, __tests__/
- Contraintes : aucune nouvelle dépendance, commentaires en anglais, exports typés

MA DEMANDE
----------
- Objectif : afficher l'état de santé de l'API dans l'en-tête de l'application
- Fichiers à créer : app/api/health/route.ts, lib/use-health.ts, components/status-badge.tsx
- Fichiers existants à modifier : app/layout.tsx (afficher <StatusBadge /> dans le <header>)
- Comportement attendu : GET /api/health renvoie { status, version, uptime } ;
  le badge se rafraîchit toutes les 30 s et affiche un point vert ou rouge
```

## Réponse attendue de l'IA (à coller telle quelle dans l'outil)

````markdown
---
pr_title: Add API health endpoint and status badge
pr_body: |
  Adds `GET /api/health`, a `useHealth()` hook refreshing every 30s and a
  `StatusBadge` component displayed in the app header.
commit_message: feat: add health endpoint and status badge
---

```ts path=app/api/health/route.ts action=create
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev',
    uptime: Math.round(process.uptime()),
  });
}
```

```ts path=lib/use-health.ts action=create
'use client';

import { useEffect, useState } from 'react';

export type Health = {
  status: 'ok' | 'error';
  version: string;
  uptime: number;
};

/** Polls /api/health every 30 seconds. */
export function useHealth(intervalMs = 30_000) {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Health;
        if (!cancelled) {
          setHealth(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    void load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { health, error };
}
```

```tsx path=components/status-badge.tsx action=create
'use client';

import { useHealth } from '@/lib/use-health';

export function StatusBadge() {
  const { health, error } = useHealth();
  const ok = !error && health?.status === 'ok';

  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        className={`h-2 w-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-red-500'}`}
        aria-hidden="true"
      />
      <span className="text-slate-600 dark:text-slate-300">
        {ok ? `API ok · v${health?.version}` : 'API unreachable'}
      </span>
    </span>
  );
}
```

```tsx path=app/layout.tsx action=patch
<<<<<<< SEARCH
import type { Metadata } from 'next';
import './globals.css';
=======
import type { Metadata } from 'next';
import { StatusBadge } from '@/components/status-badge';
import './globals.css';
>>>>>>> REPLACE
<<<<<<< SEARCH
      <header className="flex items-center justify-between px-6 py-4">
        <span className="font-semibold">Dashboard</span>
      </header>
=======
      <header className="flex items-center justify-between px-6 py-4">
        <span className="font-semibold">Dashboard</span>
        <StatusBadge />
      </header>
>>>>>>> REPLACE
```

```ts path=__tests__/health.test.ts action=create
import { GET } from '@/app/api/health/route';

describe('GET /api/health', () => {
  it('reports a healthy payload', async () => {
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.uptime).toBe('number');
  });
});
```
````

---

## Conseils

* Donnez à l'IA **le contenu exact des fichiers à modifier** (copié depuis l'onglet de votre dépôt
  ou via le bouton *Edit an existing file…* de l'outil) : les blocs `SEARCH` doivent matcher
  l'indentation au caractère près.
* Pour une grosse fonctionnalité, demandez **une PR par étape** : l'outil crée une branche, vous
  pouvez enchaîner plusieurs commits dessus avant d'ouvrir la PR.
* Si l'IA ajoute du texte autour des blocs, l'outil l'ignore : seuls les blocs délimités par des
  ``` sont pris en compte (les lignes hors blocs sont ignorées sans erreur).
* Gardez `action=create` pour les nouveaux fichiers : si le fichier existe déjà, l'outil refuse
  (au lieu d'écraser) et vous demande de corriger.
