// Vercel Serverless Function: secure Cloudinary cleanup for a deleted NEXIO store.
// Configure environment variables in Vercel; never put API_SECRET in HTML:
// CLOUDINARY_CLOUD_NAME=rtcheihd, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
// NEXIO_CLOUDINARY_DELETE_PASSWORD (a new, strong secret used only for this endpoint).
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const deletePassword = process.env.NEXIO_CLOUDINARY_DELETE_PASSWORD;
  if (!cloud || !apiKey || !apiSecret || !deletePassword) {
    return res.status(503).json({ error: 'Falta configurar CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET y NEXIO_CLOUDINARY_DELETE_PASSWORD en Vercel.' });
  }
  const body = req.body || {};
  if (typeof body.password !== 'string' || body.password !== deletePassword) {
    return res.status(401).json({ error: 'Clave de eliminación no válida.' });
  }
  if (!Array.isArray(body.urls) || body.urls.length > 500) return res.status(400).json({ error: 'Lista de archivos no válida (máximo 500).'});

  const parsed = new Map();
  for (const raw of body.urls) {
    let u;
    try { u = new URL(String(raw)); } catch { continue; }
    if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com') continue;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== cloud) continue;
    const resourceType = ['image','video','raw'].includes(parts[1]) ? parts[1] : null;
    const uploadAt = parts.indexOf('upload');
    if (!resourceType || uploadAt < 0 || uploadAt + 1 >= parts.length) continue;
    let assetParts = parts.slice(uploadAt + 1);
    // Strip Cloudinary transformation segment(s) before version/public ID.
    while (assetParts.length && /^(?:c_|w_|h_|q_|f_|dpr_|e_|g_|ar_|r_|bo_|br_|ac_|vc_|so_|eo_|du_|fl_|t_)/.test(assetParts[0])) assetParts.shift();
    if (assetParts.length && /^v\d+$/.test(assetParts[0])) assetParts.shift();
    if (!assetParts.length) continue;
    assetParts[assetParts.length - 1] = assetParts[assetParts.length - 1].replace(/\.[^.]+$/, '');
    const publicId = assetParts.join('/');
    if (!publicId || publicId.includes('..')) continue;
    const key = resourceType + ':' + publicId;
    parsed.set(key, { resourceType, publicId });
  }
  if (!parsed.size) return res.status(200).json({ deleted: 0, skipped: body.urls.length });

  const groups = new Map();
  for (const item of parsed.values()) {
    if (!groups.has(item.resourceType)) groups.set(item.resourceType, []);
    groups.get(item.resourceType).push(item.publicId);
  }
  let deleted = 0; const errors = [];
  const auth = 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64');
  for (const [resourceType, ids] of groups.entries()) {
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const endpoint = new URL(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/resources/${resourceType}/upload`);
      batch.forEach(id => endpoint.searchParams.append('public_ids[]', id));
      try {
        const response = await fetch(endpoint, { method: 'DELETE', headers: { Authorization: auth } });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) { errors.push(result.error?.message || `Cloudinary HTTP ${response.status}`); continue; }
        const deletedMap = result.deleted || {};
        const statuses = Object.entries(deletedMap);
        deleted += statuses.filter(([, status]) => status === 'deleted' || status === 'not_found').length;
        if (statuses.length !== batch.length || statuses.some(([, status]) => status !== 'deleted' && status !== 'not_found')) errors.push('Cloudinary no confirmó la eliminación de todos los recursos de un lote.');
      } catch (e) { errors.push(e.message || 'Error de red con Cloudinary.'); }
    }
  }
  if (errors.length) return res.status(502).json({ error: 'Algunos archivos no se pudieron eliminar en Cloudinary. La tienda no debe borrarse todavía.', details: errors.slice(0, 3), deleted });
  return res.status(200).json({ deleted, processed: parsed.size });
}
