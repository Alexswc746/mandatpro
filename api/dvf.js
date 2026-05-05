export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { adresse, surface, section_cadastrale, type_local = 'Appartement' } = req.body
  if (!adresse) return res.status(400).json({ error: 'Adresse manquante' })

  const surfNum = surface ? parseFloat(surface) : null

  try {
    // Géocoder pour obtenir code INSEE
    const geoRes = await fetch(
      `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(adresse)}&limit=1`
    )
    const geoData = await geoRes.json()
    if (!geoData.features?.length) {
      return res.status(200).json({ error: 'Adresse introuvable', dvf: null })
    }

    const feature = geoData.features[0]
    const [lng, lat] = feature.geometry.coordinates
    const ville = feature.properties.city
    const codePostal = feature.properties.postcode
    const codeInsee = feature.properties.citycode

    // Parser la référence cadastrale : "870H117" → section=H, numero=117
    let sectionLettre = null
    let numeroParcelle = null

    if (section_cadastrale?.trim()) {
      const raw = section_cadastrale.trim().toUpperCase()
      const match = raw.match(/([A-Z]+)(\d+)?$/)
      if (match) {
        sectionLettre = match[1]
        numeroParcelle = match[2] || null
      }
    }

    // Fonction pour récupérer TOUTES les pages de l'API Cerema
    async function fetchAllPages(baseUrl) {
      let allResults = []
      let page = 1
      let hasMore = true

      while (hasMore) {
        const url = `${baseUrl}&page=${page}&nb_resultats=500`
        const r = await fetch(url)
        if (!r.ok) break
        const data = await r.json()
        
        if (!data.results || data.results.length === 0) {
          hasMore = false
        } else {
          allResults = allResults.concat(data.results)
          // Si on a moins que la limite demandée, c'est la dernière page
          if (data.results.length < 500 || !data.next) {
            hasMore = false
          } else {
            page++
          }
        }
        // Sécurité : max 10 pages
        if (page > 10) hasMore = false
      }

      return allResults
    }

    let mutations = []
    let methode = ''

    // Priorité 1 : Parcelle exacte — toutes les ventes
    if (sectionLettre && numeroParcelle) {
      const baseUrl = `https://apidf-preprod.cerema.fr/dvf_opendata/mutations/?section=${sectionLettre}&numero_plan=${numeroParcelle}&code_insee=${codeInsee}`
      console.log('Recherche parcelle exacte:', baseUrl)
      try {
        const results = await fetchAllPages(baseUrl)
        if (results.length >= 1) {
          mutations = results
          methode = `Parcelle ${sectionLettre}${numeroParcelle}`
          console.log(`Parcelle exacte: ${mutations.length} ventes TOUTES récupérées`)
        }
      } catch(e) { console.log('Erreur parcelle:', e.message) }
    }

    // Priorité 2 : Section entière — toutes les ventes
    if (mutations.length < 3 && sectionLettre) {
      const baseUrl = `https://apidf-preprod.cerema.fr/dvf_opendata/mutations/?section=${sectionLettre}&code_insee=${codeInsee}`
      console.log('Recherche section:', baseUrl)
      try {
        const results = await fetchAllPages(baseUrl)
        if (results.length >= 3) {
          mutations = results
          methode = `Section ${sectionLettre}`
          console.log(`Section: ${mutations.length} ventes TOUTES récupérées`)
        }
      } catch(e) { console.log('Erreur section:', e.message) }
    }

    // Priorité 3 : Commune entière
    if (mutations.length < 3) {
      const baseUrl = `https://apidf-preprod.cerema.fr/dvf_opendata/mutations/?code_insee=${codeInsee}&type_local=${encodeURIComponent(type_local)}`
      console.log('Recherche commune:', baseUrl)
      try {
        const results = await fetchAllPages(baseUrl)
        if (results.length >= 3) {
          mutations = results
          methode = `Commune ${ville}`
          console.log(`Commune: ${mutations.length} ventes TOUTES récupérées`)
        }
      } catch(e) { console.log('Erreur commune:', e.message) }
    }

    if (mutations.length < 3) {
      return res.status(200).json({
        error: 'Pas assez de ventes comparables dans ce secteur',
        dvf: null,
        geo: { lat, lng, ville, codePostal, codeInsee }
      })
    }

    // Filtrer par type de bien
    let filtered = mutations.filter(t => 
      !type_local || t.type_local === type_local || !t.type_local
    )
    if (filtered.length < 3) filtered = mutations

    // Filtrer par surface ±40% si disponible
    if (surfNum) {
      const avecSurface = filtered.filter(t => {
        const s = t.surface_reelle_bati
        return s && s >= surfNum * 0.6 && s <= surfNum * 1.4
      })
      if (avecSurface.length >= 3) {
        filtered = avecSurface
        console.log(`Filtrage surface ±40%: ${filtered.length} ventes`)
      }
    }

    // Calculer prix m² pour chaque vente
    const prixM2List = filtered
      .map(t => {
        if (t.prix_m2) return t.prix_m2
        if (t.valeur_fonciere && t.surface_reelle_bati) {
          return Math.round(t.valeur_fonciere / t.surface_reelle_bati)
        }
        return null
      })
      .filter(p => p && p > 500 && p < 25000)
      .sort((a, b) => a - b)

    if (!prixM2List.length) {
      return res.status(200).json({ error: 'Données insuffisantes', dvf: null })
    }

    // Prix médian sur TOUTES les ventes — stable et reproductible
    const medianM2 = Math.round(prixM2List[Math.floor(prixM2List.length / 2)])
    const est = surfNum ? Math.round(medianM2 * surfNum) : null

    console.log(`DVF FINAL [${methode}]: ${medianM2}€/m² médian sur ${prixM2List.length} ventes`)

    return res.status(200).json({
      dvf: {
        avgM2: medianM2,
        medianM2,
        est,
        comp: prixM2List.length,
        methode,
        conf: prixM2List.length >= 10 ? 'bonne' : 'indicative',
        date: new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
        samples: filtered.slice(0, 5).map(t => ({
          d: t.date_mutation,
          s: t.surface_reelle_bati,
          p: t.valeur_fonciere,
          m: t.prix_m2 || (t.valeur_fonciere && t.surface_reelle_bati ? Math.round(t.valeur_fonciere / t.surface_reelle_bati) : null)
        }))
      },
      geo: { lat, lng, ville, codePostal, codeInsee }
    })

  } catch (err) {
    console.error('DVF error:', err.message)
    return res.status(200).json({ error: err.message, dvf: null })
  }
}
