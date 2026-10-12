// Vercel Serverless Function: safely deletes Cloudinary assets.
// Business deletion is scoped to the logged-in store activation code checked server-side against Supabase.
// Admin bulk store deletion may use NEXIO_CLOUDINARY_DELETE_PASSWORD. Never expose Cloudinary API secret in HTML.
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido.' });
  const cloud = process.env.CLOUDINARY_CLOUD_NAME || 'rtcheihd';
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!apiKey || !apiSecret) return res.status(503).json({ error: 'Faltan CLOUDINARY_API_KEY y CLOUDINARY_API_SECRET en Vercel.' });
  const body = req.body || {};
  if (!Array.isArray(body.urls) || !body.urls.length || body.urls.length > 500) return res.status(400).json({ error: 'Lista de archivos no válida (máximo 500).' });

  // Admin mode: protected by a server-only password; used by the admin panel for deleting a whole store.
  let authorized = false;
  if (typeof body.password === 'string' && process.env.NEXIO_CLOUDINARY_DELETE_PASSWORD && body.password === process.env.NEXIO_CLOUDINARY_DELETE_PASSWORD) {
    authorized = true;
  } else {
    // Business mode: no admin password prompt. Validate the store code against the server-side Supabase state.
    const supabaseUrl = process.env.SUPABASE_URL || 'https://hhexlozrekqgurtxhapc.supabase.co';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) return res.status(503).json({ error: 'Para el borrado seguro sin clave admin, configura SUPABASE_SERVICE_ROLE_KEY en Vercel.' });
    if (typeof body.storeId !== 'string' || !body.storeId || typeof body.storeCode !== 'string' || !body.storeCode.trim()) return res.status(401).json({ error: 'Debes iniciar sesión en la tienda para borrar sus archivos.' });
    try {
      const endpoint = new URL('/rest/v1/nexio_state', supabaseUrl);
      endpoint.searchParams.set('key', 'in.(accounts,products)'); endpoint.searchParams.set('select', 'key,value');
      const accountResponse = await fetch(endpoint, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!accountResponse.ok) return res.status(502).json({ error: 'No se pudo verificar la tienda con Supabase.' });
      const rows = await accountResponse.json();
      const accountsRow = Array.isArray(rows) ? rows.find(r => r.key === 'accounts') : null;
      const productsRow = Array.isArray(rows) ? rows.find(r => r.key === 'products') : null;
      const accounts = accountsRow && Array.isArray(accountsRow.value) ? accountsRow.value : [];
      const products = productsRow && Array.isArray(productsRow.value) ? productsRow.value : [];
      const account = accounts.find(a => String(a.id) === body.storeId && a.deleted !== true && a.active !== false && String(a.code || a.activationCode || '').trim().toUpperCase() === body.storeCode.trim().toUpperCase());
      if (!account) return res.status(403).json({ error: 'El código de activación no corresponde a una tienda activa.' });
      const ownedUrls = new Set([account.logo, account.introVideo, ...products.filter(p => String(p.storeId) === String(account.id)).map(p => p.mediaUrl)].filter(Boolean));
      const requestedUrls = body.urls.filter(u => typeof u === 'string');
      if (requestedUrls.some(u => !ownedUrls.has(u))) return res.status(403).json({ error: 'La tienda solo puede borrar archivos asociados a su propio perfil o artículos.' });
      authorized = true;
      body.allowedStoreId = String(account.id);
    } catch (e) { return res.status(502).json({ error: 'No se pudo validar la tienda con Supabase.' }); }
  }
  if (!authorized) return res.status(401).json({ error: 'No autorizado para borrar archivos.' });

  const parsed = new Map();
  for (const raw of body.urls) {
    let u; try { u = new URL(String(raw)); } catch { continue; }
    if (u.protocol !== 'https:' || u.hostname !== 'res.cloudinary.com') continue;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 4 || parts[0] !== cloud) continue;
    const resourceType = ['image','video','raw'].includes(parts[1]) ? parts[1] : null;
    const uploadAt = parts.indexOf('upload'); if (!resourceType || uploadAt < 0 || uploadAt + 1 >= parts.length) continue;
    let assetParts = parts.slice(uploadAt + 1);
    while (assetParts.length && /^(?:c_|w_|h_|q_|f_|dpr_|e_|g_|ar_|r_|bo_|br_|ac_|vc_|so_|eo_|du_|fl_|t_)/.test(assetParts[0])) assetParts.shift();
    if (assetParts.length && /^v\d+$/.test(assetParts[0])) assetParts.shift();
    if (!assetParts.length) continue;
    assetParts[assetParts.length - 1] = assetParts[assetParts.length - 1].replace(/\.[^.]+$/, '');
    const publicId = assetParts.join('/');
    if (!publicId || publicId.includes('..')) continue;
    if (body.allowedStoreId) {
      // Uploaded products are grouped under nexionet/productos; store videos under nexionet/tiendas/videos.
      // Legacy logos are shared account assets; allow only NEXIO app namespaces.
      if (!/^nexionet\/(productos|logos|banners|tiendas\/videos)\//.test(publicId)) continue;
    }
    parsed.set(resourceType + ':' + publicId, { resourceType, publicId });
  }
  if (!parsed.size) return res.status(400).json({ error: 'No se reconocieron URLs válidas de Cloudinary; no se eliminó ningún archivo.', deleted: 0 });
  const groups = new Map();
  for (const item of parsed.values()) { if (!groups.has(item.resourceType)) groups.set(item.resourceType, []); groups.get(item.resourceType).push(item.publicId); }
  let deleted = 0; const errors = []; const auth = 'Basic ' + Buffer.from(apiKey + ':' + apiSecret).toString('base64');
  for (const [resourceType, ids] of groups.entries()) for (let i=0; i<ids.length; i+=100) {
    const batch=ids.slice(i,i+100); const endpoint=new URL(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/resources/${resourceType}/upload`);
    batch.forEach(id=>endpoint.searchParams.append('public_ids[]',id));
    try { const response=await fetch(endpoint,{method:'DELETE',headers:{Authorization:auth}}); const result=await response.json().catch(()=>({}));
      if(!response.ok){errors.push(result.error?.message||`Cloudinary HTTP ${response.status}`);continue;}
      const statuses=Object.entries(result.deleted||{}); deleted+=statuses.filter(([,v])=>v==='deleted'||v==='not_found').length;
      if(statuses.length!==batch.length||statuses.some(([,v])=>v!=='deleted'&&v!=='not_found')) errors.push('Cloudinary no confirmó la eliminación de todos los recursos.');
    } catch(e){errors.push(e.message||'Error de red con Cloudinary.');}
  }
  if(errors.length)return res.status(502).json({error:'No se pudieron eliminar todos los archivos. El artículo se conservará.',details:errors.slice(0,3),deleted});
  return res.status(200).json({deleted,processed:parsed.size});
};
