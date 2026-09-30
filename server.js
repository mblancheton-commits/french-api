const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

// Fonction pour déterminer la clé API (clé élève en header ou clé prof sur Render)
function obtenirCleAPI(req) {
    const cleEleve = req.headers['x-custom-api-key'];
    if (cleEleve && cleEleve.trim().startsWith("AIzaSy")) return cleEleve.trim();
    return process.env.GEMINI_API_KEY;
}

// Fonction de pause asynchrone (pour gérer les surcharges Google)
const attendre = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// APPEL AVEC SECOURS STRICT SUR LA GAMME FLASH 3.x (3.7, 3.8, 3.6, 3.5)
async function appelerGeminiAvecSecours(contents, modelPrefere, apiKey) {
    // Liste ordonnée des modèles Flash disponibles
    const modelesDisponibles = [
        modelPrefere || 'gemini-3.7-flash',
        'gemini-3.7-flash',
        'gemini-3.8-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash'
    ];
    // Élimination des doublons
    const listeAtester = [...new Set(modelesDisponibles)];

    let journalErreurs = [];

    for (const modele of listeAtester) {
        console.log(`[IA] Essai avec le modèle : ${modele}...`);
        
        // Tentative avec 1 réessai en cas de surcharge (503/429)
        for (let tentative = 1; tentative <= 2; tentative++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: contents,
                        generationConfig: { responseMimeType: "application/json" }
                    })
                });

                const data = await response.json();

                if (data.error) {
                    const code = data.error.code || response.status;
                    const msg = data.error.message || "Erreur inconnue";
                    console.warn(`[IA] Échec ${modele} (tentative ${tentative}) : [Code ${code}] ${msg}`);

                    // Si le modèle est surchargé (503 ou 429), attendre 2 secondes et réessayer une fois
                    if ((code === 503 || code === 429) && tentative === 1) {
                        console.log(`[IA] Modèle ${modele} surchargé. Pause de 2 secondes avant réessai...`);
                        await attendre(2000);
                        continue;
                    }

                    journalErreurs.push(`${modele}: [Code ${code}] ${msg}`);
                    break; // Passer au modèle suivant
                }

                if (data.candidates && data.candidates[0].content.parts[0].text) {
                    let texte = data.candidates[0].content.parts[0].text;
                    texte = texte.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                    console.log(`[IA] Succès avec le modèle : ${modele} !`);
                    return JSON.parse(texte);
                }
            } catch (err) {
                console.warn(`[IA] Erreur réseau avec ${modele} : ${err.message}`);
                journalErreurs.push(`${modele}: ${err.message}`);
                break;
            }
        }
    }

    // Si tous les modèles ont échoué, renvoyer le rapport détaillé
    throw new Error("Échec de tous les modèles testés :\n" + journalErreurs.join("\n"));
}

// ENDPOINT 1 : ANALYSE DU PDF EN FICHES ATOMIQUES ET EXERCICES
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Aucune clé API Gemini disponible." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.7-flash';
        const pdfBase64 = req.file.buffer.toString('base64');

        const prompt = `
Tu es un professeur de FLE pour apprenants coréens. Analyse ce document PDF de cours et d'exercices de français :

RÈGLES STRICTES DE DÉCOUPAGE :
1. "slides_cours" (Fiches de cours atomiques - Micro-learning) :
   - Découpe la grammaire en fiches courtes et indépendantes (1 seule règle ou nuance par fiche).
   - Entièrement rédigé en coréen clair et pédagogique.
   - Donne un titre clair à chaque fiche (ex: "1. La négation simple", "2. Ne...plus (sens et prononciation)").
   - Inclus des exemples en français expliqués en coréen.

2. "exercices" (Sections pratiques) :
   - Extrais les exercices sous forme de sections distinctes.
   - S'il y a des phrases à compléter : utilise "____".
   - S'il y a des questions ouvertes de conversation/rédaction : conserve-les clairement formulées.

Structure JSON obligatoire :
{
  "titre": "Titre de la leçon",
  "slides_cours": [
    {
      "numero": 1,
      "titre": "Titre de la fiche",
      "contenu_coreen": "Explications en coréen avec exemples..."
    }
  ],
  "exercices": [
    {
      "titre": "Section d'exercice",
      "consigne": "Consigne éventuelle",
      "questions": [
        { "q": "Question ou phrase", "type": "text" }
      ]
    }
  ]
}
`;

        const contents = [{
            parts: [
                { text: prompt },
                { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }
            ]
        }];

        const resultatJson = await appelerGeminiAvecSecours(contents, modelChoisi, apiKey);
        res.json(resultatJson);

    } catch (err) {
        console.error("Erreur serveur analyse :", err);
        res.status(500).json({ error: err.message });
    }
});

// ENDPOINT 2 : CHAT / AJUSTEMENT INTERACTIF
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Aucune clé API disponible." });

        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.7-flash';
        const { contenuActuel, instruction } = req.body;

        if (!contenuActuel || !instruction) {
            return res.status(400).json({ error: "Données de modification manquantes." });
        }

        const prompt = `
Tu es un professeur de FLE pour élèves coréens.
Voici le contenu actuel d'un cours structuré en fiches de grammaire et exercices :
${JSON.stringify(contenuActuel, null, 2)}

INSTRUCTION DU PROFESSEUR :
"${instruction}"

Applique la demande du professeur en conservant la structure JSON exacte (titre, slides_cours, exercices).
Renvoie UNIQUEMENT le JSON mis à jour :
`;

        const contents = [{ parts: [{ text: prompt }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, modelChoisi, apiKey);
        res.json(resultatJson);

    } catch (err) {
        console.error("Erreur serveur ajustement :", err);
        res.status(500).json({ error: err.message });
    }
});

// ENDPOINT 3 : DIAGNOSTIC DIRECT DES MODÈLES DISPONIBLES SUR VOTRE CLÉ
app.get('/api/verifier-modeles', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.json({ erreur: "Pas de clé GEMINI_API_KEY sur Render." });

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await response.json();
        res.json(data);
    } catch(e) {
        res.status(500).json({ erreur: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
