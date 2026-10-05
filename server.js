const express = require('express');
const cors = require('cors');
const multer = require('multer');

let pdfParse = require('pdf-parse');
if (typeof pdfParse !== 'function' && pdfParse.default) {
    pdfParse = pdfParse.default;
}

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

function obtenirCleGemini(req) {
    const cle = req.headers['x-custom-api-key'];
    if (cle && cle.trim().startsWith("AIzaSy")) return cle.trim();
    return process.env.GEMINI_API_KEY;
}

function obtenirCleNanoGPT(req) {
    const cleHeader = req.headers['x-nanogpt-key'];
    if (cleHeader && cleHeader.trim()) return cleHeader.trim();
    return process.env.NANOGPT_API_KEY;
}

// NETTOYEUR ET RÉPARATEUR DE JSON STRICT
function reparerEtParserJSON(texteBrut) {
    let t = texteBrut;
    t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    t = t.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    const premier = t.indexOf('{');
    const dernier = t.lastIndexOf('}');
    if (premier !== -1 && dernier !== -1) {
        t = t.substring(premier, dernier + 1);
    }

    try {
        return JSON.parse(t);
    } catch (err) {
        // En cas de coupure ou guillemet non fermé
        console.error("Erreur parsing JSON brut :", err.message);
        throw new Error("L'IA a produit une réponse JSON incomplète ou mal formée : " + err.message);
    }
}

// APPEL STABLE NANOGPT
async function appelerNanoGPT(messages, model, apiKey) {
    if (!apiKey) throw new Error("Clé API NanoGPT manquante.");

    const response = await fetch("https://nano-gpt.com/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "x-api-key": apiKey
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            temperature: 0.1,
            max_tokens: 8192
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(`[NanoGPT - ${model}] ${data.error.message || JSON.stringify(data.error)}`);

    if (data.choices && data.choices[0] && data.choices[0].message) {
        return reparerEtParserJSON(data.choices[0].message.content || "");
    }
    throw new Error(`Aucune réponse exploitable renvoyée par ${model}.`);
}

// APPEL GEMINI
async function appelerGemini(contents, model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: contents,
            generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 }
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(`[Gemini] ${data.error.message || JSON.stringify(data.error)}`);

    if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts[0].text) {
        return reparerEtParserJSON(data.candidates[0].content.parts[0].text);
    }
    throw new Error("Réponse vide reçue de Gemini.");
}

// 1. ENDPOINT ANALYSE PDF (PIPELINE EN 2 ÉTAPES : ZÉRO DÉPASSEMENT DE TAILLE)
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const modelChoisi = req.headers['x-model-choice'] || 'deepseek/deepseek-v4.1-flash:thinking';
        const apiKeyNano = obtenirCleNanoGPT(req);
        const apiKeyGemini = obtenirCleGemini(req);

        // Extraction texte du PDF
        let texteExtrait = "";
        try {
            const fnParser = typeof pdfParse === 'function' ? pdfParse : (pdfParse.default || pdfParse);
            const donneesPdf = await fnParser(req.file.buffer);
            texteExtrait = (donneesPdf && donneesPdf.text) ? donneesPdf.text : "";
        } catch(eParser) {
            throw new Error("Impossible de lire le texte du PDF : " + eParser.message);
        }

        // --- ÉTAPE 1 : THÉORIE (COURS, POINTS CLÉS & QUIZ) ---
        const promptTheorie = `
Tu es un professeur de FLE. Analyse ce document et génère EXCLUSIVEMENT la partie théorique (Cours aéré avec une phrase par ligne, points importants en 3 langues, quiz théorique en 3 langues).

Structure JSON STRICTE :
{
  "titre": "Titre exact de la leçon",
  "bloc_cours": {
    "titre": "Cours théorique",
    "slides": [
      {
        "numero": 1,
        "titre": "Titre section",
        "phrases_fr": ["Phrase 1...", "Phrase 2...", "Exemple : ..."],
        "phrases_en": ["Sentence 1...", "Sentence 2...", "Example: ..."],
        "phrases_ko": ["설명 1...", "설명 2...", "예문: ..."]
      }
    ]
  },
  "points_importants": {
    "fr": ["Point clé 1...", "Point clé 2..."],
    "en": ["Key point 1...", "Key point 2..."],
    "ko": ["핵심 포인트 1...", "핵심 포인트 2..."]
  },
  "quiz_theorique": {
    "titre": "Quiz de vérification du cours",
    "questions": [
      {
        "id": 1,
        "question": { "fr": "Question FR ?", "en": "Question EN ?", "ko": "질문 KO ?" },
        "options": { "fr": ["A", "B", "C"], "en": ["A", "B", "C"], "ko": ["A", "B", "C"] },
        "reponse_correcte_index": 0,
        "explication": { "fr": "Explication...", "en": "Explanation...", "ko": "해설..." }
      }
    ]
  }
}
`;

        // --- ÉTAPE 2 : EXERCICES COMPLETS (100% DES PHRASES) ---
        const promptExercices = `
Tu es un professeur de FLE. Analyse ce document et extrais ABSOLUMENT TOUTES LES PHRASES d'exercices présentes dans le texte, de la première à la toute dernière, sans jamais en omettre une seule.
Chaque phrase doit comporter ses trous "____".

Structure JSON STRICTE :
{
  "blocs_exercices": [
    {
      "id": "exo_1",
      "titre": "Exercice 1",
      "consigne": "Consigne complète",
      "questions": [
        { "q": "Phrase complète 1 avec ____." },
        { "q": "Phrase complète 2 avec ____." }
      ]
    },
    {
      "id": "exo_2",
      "titre": "Exercice 2",
      "consigne": "Consigne complète",
      "questions": [
        { "q": "Phrase complète avec ____." }
      ]
    }
  ]
}
`;

        let theorieJson = null;
        let exercicesJson = null;

        if (modelChoisi.startsWith("gemini")) {
            if (!apiKeyGemini) return res.status(500).json({ error: "Clé Gemini absente." });
            const pdfBase64 = req.file.buffer.toString('base64');
            const contents1 = [{ parts: [{ text: promptTheorie }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }];
            const contents2 = [{ parts: [{ text: promptExercices }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }];
            theorieJson = await appelerGemini(contents1, modelChoisi, apiKeyGemini);
            exercicesJson = await appelerGemini(contents2, modelChoisi, apiKeyGemini);
        } else {
            if (!apiKeyNano) return res.status(500).json({ error: "Clé NanoGPT absente." });
            
            const msg1 = [
                { role: "system", content: "Réponds UNIQUEMENT en JSON strict." },
                { role: "user", content: `${promptTheorie}\n\n[TEXTE DU PDF] :\n${texteExtrait}` }
            ];
            const msg2 = [
                { role: "system", content: "Extrais 100% des phrases d'exercices. Réponds UNIQUEMENT en JSON strict." },
                { role: "user", content: `${promptExercices}\n\n[TEXTE DU PDF] :\n${texteExtrait}` }
            ];

            // Exécution des deux parties
            theorieJson = await appelerNanoGPT(msg1, modelChoisi, apiKeyNano);
            exercicesJson = await appelerNanoGPT(msg2, modelChoisi, apiKeyNano);
        }

        // Assemblage final parfait
        const resultatFinal = {
            titre: theorieJson.titre || "Chapitre de cours",
            bloc_cours: theorieJson.bloc_cours || null,
            points_importants: theorieJson.points_importants || null,
            quiz_theorique: theorieJson.quiz_theorique || null,
            blocs_exercices: (exercicesJson && exercicesJson.blocs_exercices) ? exercicesJson.blocs_exercices : []
        };

        // Formatage avec double saut de ligne
        if (resultatFinal.bloc_cours && Array.isArray(resultatFinal.bloc_cours.slides)) {
            resultatFinal.bloc_cours.slides.forEach(s => {
                if (Array.isArray(s.phrases_fr)) s.contenu_fr = s.phrases_fr.join("\n\n");
                if (Array.isArray(s.phrases_en)) s.contenu_en = s.phrases_en.join("\n\n");
                if (Array.isArray(s.phrases_ko)) s.contenu_ko = s.phrases_ko.join("\n\n");
            });
        }

        res.json(resultatFinal);

    } catch (err) {
        console.error("Erreur analyser-pdf :", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. ENDPOINT AJUSTEMENT CONTENU
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const { contenuActuel, instruction } = req.body;
        const modelChoisi = req.headers['x-model-choice'] || 'deepseek/deepseek-v4.1-flash:thinking';

        const prompt = `
Tu es un professeur de FLE. Voici le cours actuel en JSON :
${JSON.stringify(contenuActuel, null, 2)}

INSTRUCTION DU PROFESSEUR :
"${instruction}"

RÈGLE : Conserve impérativement TOUTES les phrases des exercices.
Renvoie STRICTEMENT le JSON complet mis à jour :
`;

        let resultatJson = null;

        if (modelChoisi.startsWith("gemini")) {
            const apiKey = obtenirCleGemini(req);
            if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
            const contents = [{ parts: [{ text: prompt }] }];
            resultatJson = await appelerGemini(contents, modelChoisi, apiKey);
        } else {
            const apiKeyNano = obtenirCleNanoGPT(req);
            if (!apiKeyNano) return res.status(500).json({ error: "Clé NanoGPT absente." });

            const messages = [
                { role: "system", content: "Réponds STRICTEMENT en JSON sans fioritures." },
                { role: "user", content: prompt }
            ];

            resultatJson = await appelerNanoGPT(messages, modelChoisi, apiKeyNano);
        }

        res.json(resultatJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ENDPOINT EMMA (FLASH LITE)
app.post('/api/corriger-emma', async (req, res) => {
    try {
        const apiKey = obtenirCleGemini(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });

        const { question, reponseEleve, langue } = req.body;
        const langCode = (langue || 'fr').toLowerCase();

        let consigneLangue = "Donne toutes tes explications grammaticales en Français.";
        let nomLangue = "français";
        if (langCode === 'ko') {
            consigneLangue = "Rédige TOUTES les explications pédagogiques (ce qui est bien, fautes, améliorations) en CORÉEN (한국어). Traduis aussi la réponse amicale et la phrase corrigée en coréen.";
            nomLangue = "coréen";
        } else if (langCode === 'en') {
            consigneLangue = "Rédige TOUTES les explications pédagogiques (ce qui est bien, fautes, améliorations) en ANGLAIS. Traduis aussi la réponse amicale et la phrase corrigée en anglais.";
            nomLangue = "anglais";
        }

        if (!reponseEleve || !reponseEleve.trim()) {
            return res.json({
                reponse_amicale: "Tu n'as rien écrit ! N'aie pas peur d'essayer. 😊",
                traduction_reponse: langCode === 'ko' ? "아무것도 쓰지 않았어요! 두려워하지 말고 시도해 보세요. 😊" : (langCode === 'en' ? "You wrote nothing! Don't be afraid to try. 😊" : ""),
                ce_qui_est_bien: langCode === 'ko' ? "아직 없음." : "Rien pour l'instant.",
                les_fautes: langCode === 'ko' ? "답변이 비어 있습니다." : "La réponse est vide.",
                phrase_corrigee: "Écris une phrase complète.",
                traduction_phrase_corrigee: langCode === 'ko' ? "완전한 문장을 작성하세요." : (langCode === 'en' ? "Write a full sentence." : ""),
                ameliorations: langCode === 'ko' ? "직접 작성해 보세요!" : "Lance-toi !"
            });
        }

        const prompt = `
Tu es Emma, une amie française bienveillante (A2-B1).
Question posée : "${question}"
Phrase écrite par l'élève : "${reponseEleve}"
Langue cible pour les explications de l'élève : ${nomLangue}.

[INSTRUCTIONS DE LANGUE]
${consigneLangue}
- La réponse amicale d'Emma doit TOUJOURS être en Français naturel et simple (A2-B1).
- Si la langue n'est pas le français, donne la traduction de cette réponse dans "traduction_reponse".
- Donne la traduction de la phrase corrigée dans "traduction_phrase_corrigee".

[ANTI-HALLUCINATION]
1. Regarde VRAIMENT la phrase de l'élève.
2. Si majuscule présente -> INTERDICTION de dire qu'elle manque.
3. Si point (.) présent -> INTERDICTION de dire qu'il manque.
4. Corrige uniquement les vraies fautes.

Structure JSON :
{
  "reponse_amicale": "...",
  "traduction_reponse": "...",
  "ce_qui_est_bien": "...",
  "les_fautes": "...",
  "phrase_corrigee": "...",
  "traduction_phrase_corrigee": "...",
  "ameliorations": "..."
}
`;
        const contents = [{ parts: [{ text: prompt }] }];
        const modeles = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
        let resJson = null;
        for (const m of modeles) {
            try {
                resJson = await appelerGemini(contents, m, apiKey);
                if (resJson) break;
            } catch(e) {}
        }
        res.json(resJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 4. ENDPOINT GÉNÉRATION D'ENTRAÎNEMENT (FLASH LITE)
app.post('/api/generer-entrainement', async (req, res) => {
    try {
        const apiKey = obtenirCleGemini(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });

        const { titreSource, contexteExemples, format, nbPhrases } = req.body;
        const nombre = Math.min(Math.max(parseInt(nbPhrases) || 5, 3), 15);
        const typeFormat = format === 'text' ? 'text' : 'select';

        const prompt = `
Tu es un professeur de FLE créant des exercices d'entraînement.
Thème : "${titreSource}"
Exemples : ${JSON.stringify(contexteExemples || []).slice(0, 800)}
Génère ${nombre} phrases avec un trou "____".

Structure JSON :
{
  "titre": "Entraînement : ${titreSource}",
  "phrases": [
    {
      "q": "Phrase modèle avec ____.",
      "type": "${typeFormat}",
      ${typeFormat === 'select' ? '"options": ["choix1", "choix2", "choix3"],' : ''}
      "a": ["bonne_reponse"]
    }
  ]
}
`;
        const contents = [{ parts: [{ text: prompt }] }];
        const modeles = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'];
        let resJson = null;
        for (const m of modeles) {
            try {
                resJson = await appelerGemini(contents, m, apiKey);
                if (resJson) break;
            } catch(e) {}
        }
        res.json(resJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
