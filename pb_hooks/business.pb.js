// JRZ Internal POS — Order / Inventory + Cash Ledger business hooks.
//
// Architecture (no custom backend server):
//   React (PocketBase JS SDK, normal authenticated requests)
//     -> custom routes below (pb_hooks JSVM)
//       -> $app.runInTransaction + txApp DAO (bypasses collection API rules)
//
// Why server-side instead of client Batch API:
// - cash_transactions.createRule is null (nobody may create via the data API;
//   ledger rows are created here through the DAO, which bypasses API rules).
// - Validate-then-mutate runs inside ONE SQLite transaction. PocketBase allows
//   only a single writer at a time, so concurrent checkouts/transitions are
//   serialized: no lost updates, no oversell, no double CASH_IN.
// - Direct client writes that could bypass validation are blocked by the
//   onRecord*Request guards at the bottom of this file.
//
// IMPORTANT JSVM scoping rule (verified live on this project): route handlers
// can NOT see file top-level helper functions at request time
// ("ReferenceError: xxx is not defined"). Only PocketBase-injected globals
// ($app, routerAdd, DynamicModel, arrayOf, ApiError types, console) plus
// handler-local declarations are visible. Therefore EVERY handler below is
// fully self-contained: any helper it needs is declared INSIDE the handler.
// Do NOT refactor these into file top-level functions.
//
// Timezone note: the JSVM has no Intl (verified live: hasIntl=false), so IANA
// business-week math cannot run here. The frontend computes the current
// business-week start with the centralized timezone utility
// (VITE_APP_TIMEZONE, Monday 06:00 local) and sends it as `week_start`.
// The checkout handler validates the format and clamps it (valid ISO, not in
// the future, at most 8 days old) and uses it only as the lower bound of the
// weekly-usage query. All quantities, prices, stock and statuses are read
// authoritatively from the database inside the transaction.

// ---- diagnostics (pre-existing) ----
routerAdd("GET", "/api/ping-test", function(e){
  return e.json(200, {ok:true, hasIntl: typeof Intl !== "undefined"});
}, $apis.requireAuth());

routerAdd("GET", "/api/intl-test", function(e){
  try{
    var has = typeof Intl !== "undefined";
    var tz = "Asia/Jakarta";
    var parts = "nope";
    if(has){
      var fmt = new Intl.DateTimeFormat("en-US", {timeZone: tz, weekday:"short"});
      parts = fmt.format(new Date());
    }
    return e.json(200, {hasIntl: has, parts: parts});
  } catch(err){
    return e.json(200, {hasIntl: false, error: String(err)});
  }
}, $apis.requireAuth());

// ---- POST /api/orders/checkout ----
routerAdd("POST", "/api/orders/checkout", function(e){
  function num(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return n;
  }
  // SERVER-AUTHORITATIVE business-week start (Monday 06:00 wall time).
  // The JSVM has no Intl/timezone database, so the hook cannot resolve an
  // IANA name. It reads JRZ_TZ_OFFSET_MINUTES (minutes east of UTC) from the
  // server process environment via $os.getenv and computes the boundary with
  // pure arithmetic. No zone name is hardcoded. Missing/invalid config fails
  // closed. Any client-supplied week_start in the request body is IGNORED.
  function serverWeekStartNorm() {
    var raw = "";
    try { raw = $os.getenv("JRZ_TZ_OFFSET_MINUTES"); } catch (errW) { raw = ""; }
    raw = String(raw == null ? "" : raw).trim();
    if (!raw) throw new BadRequestError("Konfigurasi timezone server belum diatur.");
    var offMin = Number(raw);
    if (!isFinite(offMin) || Math.floor(offMin) !== offMin || offMin % 15 !== 0 || offMin < -840 || offMin > 840) {
      throw new BadRequestError("Konfigurasi timezone server tidak valid.");
    }
    var nowMs = Date.now();
    var wallMs = nowMs + offMin * 60000;
    var wall = new Date(wallMs);
    var wd = wall.getUTCDay();
    var back = (wd + 6) % 7;
    var midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 0, 0, 0, 0);
    var monday0600wall = midnight - back * 86400000 + 6 * 3600000;
    if (wallMs < monday0600wall) monday0600wall -= 7 * 86400000;
    var iso = new Date(monday0600wall - offMin * 60000).toISOString();
    return iso.substring(0, 10) + " " + iso.substring(11, 19);
  }
  function toOrderJSON(rec) {
    var completed = rec.get("completed_at");
    return {
      id: rec.id,
      user: rec.getString("user"),
      in_game_name: rec.getString("in_game_name"),
      in_game_phone: rec.getString("in_game_phone"),
      notes: rec.getString("notes"),
      status: rec.getString("status"),
      total: num(rec.get("total"), 0),
      completed_at: completed ? String(completed) : null,
    };
  }

  var body = e.requestInfo().body || {};
  var authColl = "";
  try { authColl = e.auth.collection().name; } catch (err2) { throw new ForbiddenError("Login diperlukan."); }

  var result = {};
  var notifyUserId = "";
  $app.runInTransaction(function(txApp){
    function weeklyUsage(userId, weekStartNorm) {
      // NOTE: identifiers are double-quoted — `order` is a reserved word in
      // SQLite and unquoted use is a syntax error.
      var rows = arrayOf(new DynamicModel({ catalog: "", qty: 0 }));
      txApp.db().newQuery(
        "SELECT oi.\"catalog\" AS catalog, COALESCE(SUM(oi.\"quantity\"),0) AS qty " +
        "FROM \"order_items\" oi INNER JOIN \"orders\" o ON o.\"id\" = oi.\"order\" " +
        "WHERE o.\"user\" = {:u} AND o.\"created\" >= {:ws} AND (o.\"status\" = 'Pending' OR o.\"status\" = 'Completed') " +
        "GROUP BY oi.\"catalog\""
      ).bind({ u: userId, ws: weekStartNorm }).all(rows);
      var out = {};
      for (var i = 0; i < rows.length; i++) {
        out[rows[i].catalog] = Number(rows[i].qty) || 0;
      }
      return out;
    }

    // Resolve target gank: users act as themselves; admins/superusers may act
    // for a gank by passing body.user (used by Admin tooling/support).
    var targetUserId = "";
    if (authColl === "users") {
      targetUserId = e.auth.id;
    } else if (authColl === "admins" || authColl === "_superusers") {
      targetUserId = String(body.user || "");
      if (!targetUserId) throw new BadRequestError("user wajib diisi.");
    } else {
      throw new ForbiddenError("Login diperlukan.");
    }
    notifyUserId = targetUserId;

    var gank = null;
    try {
      gank = txApp.findRecordById("users", targetUserId);
    } catch (err3) {
      throw new BadRequestError("User/gank tidak ditemukan.");
    }
    if (!gank.getBool("active")) throw new BadRequestError("User/gank tidak aktif.");

    var inName = String(body.in_game_name || "").trim();
    var inPhone = String(body.in_game_phone || "").trim();
    if (!inName) throw new BadRequestError("Nama In-Game wajib diisi.");
    if (inName.length > 255) throw new BadRequestError("Nama In-Game maksimal 255 karakter.");
    if (!inPhone) throw new BadRequestError("No. Telepon In-Game wajib diisi.");
    if (inPhone.length > 50) throw new BadRequestError("No. Telepon In-Game maksimal 50 karakter.");
    var notes = String(body.notes || "");
    if (notes.length > 1000) throw new BadRequestError("Notes maksimal 1000 karakter.");

    var items = body.items;
    if (!items || !(items instanceof Array) || items.length === 0) {
      throw new BadRequestError("Cart kosong.");
    }
    if (items.length > 100) throw new BadRequestError("Terlalu banyak item.");

    // Merge duplicate catalog lines (sum quantities).
    var merged = {};
    var order2 = [];
    for (var i = 0; i < items.length; i++) {
      var line = items[i] || {};
      var cid = String(line.catalog || "");
      var q = Number(line.quantity);
      if (!cid) throw new BadRequestError("Catalog wajib diisi.");
      if (!Number.isInteger(q) || q < 1) throw new BadRequestError("Quantity harus integer >= 1.");
      if (!merged[cid]) { merged[cid] = 0; order2.push(cid); }
      merged[cid] += q;
    }

    // body.week_start (if present) is deliberately IGNORED: the boundary is
    // always derived server-side from Date.now() + configured offset.
    var weekStartNorm = serverWeekStartNorm();
    var usage = null;
    try {
      usage = weeklyUsage(targetUserId, weekStartNorm);
    } catch (errU) {
      throw new BadRequestError("Weekly usage tidak dapat dihitung saat ini.");
    }

    // Validate ALL lines before writing anything (all-or-nothing).
    var prepared = [];
    var total = 0;
    for (var k = 0; k < order2.length; k++) {
      var catalogId = order2[k];
      var qty2 = merged[catalogId];
      var cat = null;
      try {
        cat = txApp.findRecordById("catalog", catalogId);
      } catch (err4) {
        throw new BadRequestError("Catalog tidak ditemukan.");
      }
      if (!cat.getBool("active")) throw new BadRequestError("Item '" + cat.getString("name") + "' sudah tidak aktif.");

      var stock = num(cat.get("stock"), 0);
      var reserved = num(cat.get("reserved_stock"), 0);
      var available = stock - reserved;
      if (qty2 > available) {
        throw new BadRequestError("Stock '" + cat.getString("name") + "' tidak cukup (tersisa " + Math.max(0, available) + ").");
      }

      var effLimit = num(cat.get("weekly_limit"), 0);
      var ovr = null;
      try {
        ovr = txApp.findFirstRecordByFilter(
          "weekly_limit_overrides", "gank = {:g} && catalog = {:c}", { g: targetUserId, c: catalogId }
        );
      } catch (err5) { ovr = null; }
      if (ovr) effLimit = num(ovr.get("weekly_limit"), effLimit);
      var used = usage[catalogId] || 0;
      if (used + qty2 > effLimit) {
        throw new BadRequestError("Weekly limit '" + cat.getString("name") + "' terlampaui (sisa " + Math.max(0, effLimit - used) + ").");
      }

      var price = num(cat.get("price"), 0);
      total += qty2 * price;
      prepared.push({ cat: cat, qty: qty2, price: price });
    }

    // Commit: order + items (price snapshot) + reserved_stock.
    var ordersCol = txApp.findCollectionByNameOrId("orders");
    var orderRec = new Record(ordersCol);
    orderRec.set("user", targetUserId);
    orderRec.set("in_game_name", inName);
    orderRec.set("in_game_phone", inPhone);
    orderRec.set("notes", notes);
    orderRec.set("status", "Pending");
    orderRec.set("total", total);
    txApp.save(orderRec);

    var itemsCol = txApp.findCollectionByNameOrId("order_items");
    var outItems = [];
    for (var p = 0; p < prepared.length; p++) {
      var it = new Record(itemsCol);
      it.set("order", orderRec.id);
      it.set("catalog", prepared[p].cat.id);
      it.set("quantity", prepared[p].qty);
      it.set("unit_price", prepared[p].price);
      txApp.save(it);
      var cres = prepared[p].cat.get("reserved_stock");
      prepared[p].cat.set("reserved_stock", num(cres, 0) + prepared[p].qty);
      txApp.save(prepared[p].cat);
      outItems.push({
        id: it.id,
        order: orderRec.id,
        catalog: prepared[p].cat.id,
        catalog_name: prepared[p].cat.getString("name"),
        quantity: prepared[p].qty,
        unit_price: prepared[p].price,
      });
    }

    result.order = toOrderJSON(orderRec);
    result.items = outItems;
  });

  // Post-commit Discord side effect (OUTSIDE the transaction): the Pending
  // order is already committed, so a webhook failure must never roll it back.
  // Only checkout triggers this — complete/cancel/supplier paths never call it.
  try {
    sendDiscordOrderNotification(result.order, result.items, notifyUserId);
  } catch (errD) {
    try {
      $app.logger().warn("Discord order notification failed", "order", result.order ? result.order.id : "", "error", String(errD));
    } catch (errE) {}
  }
  return e.json(200, result);

  // Nested (same-invocation scope) on purpose — see the scoping note on top.
  function sendDiscordOrderNotification(order, items, gankUserId) {
    var url = "";
    try { url = $os.getenv("JRZ_DISCORD_WEBHOOK_URL"); } catch (errU) { url = ""; }
    url = String(url == null ? "" : url).trim();
    if (!url) return; // missing config: safe no-op, order unaffected
    var mention = "";
    try { mention = $os.getenv("JRZ_DISCORD_MENTION"); } catch (errM) { mention = ""; }
    mention = String(mention == null ? "" : mention).trim();

    function money(n) {
      var v = Math.floor(Math.abs(Number(n) || 0));
      var s = String(v);
      var out = "";
      while (s.length > 3) { out = "." + s.slice(-3) + out; s = s.slice(0, -3); }
      return "$" + s + out;
    }

    var gankName = gankUserId;
    try {
      var gu = $app.findRecordById("users", gankUserId);
      var un = gu.getString("username");
      if (un) gankName = un;
    } catch (errG) {}

    var lines = [];
    lines.push("🛒 ORDER BARU " + order.id);
    lines.push("");
    lines.push("Gank: " + gankName);
    lines.push("Nama In-Game: " + order.in_game_name);
    lines.push("No. HP: " + order.in_game_phone);
    lines.push("");
    lines.push("Items:");
    for (var k = 0; k < items.length; k++) {
      var nm = items[k].catalog_name || items[k].catalog;
      lines.push("• " + nm + " × " + items[k].quantity);
    }
    lines.push("");
    lines.push("Total: " + money(order.total));
    lines.push("Status: PENDING");
    if (mention) lines.push(mention);

    var res = $http.send({
      url: url,
      method: "POST",
      body: JSON.stringify({ content: lines.join("\n") }),
      headers: { "content-type": "application/json" },
      timeout: 15,
    });
    if (!res || res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error("Discord webhook responded " + (res ? res.statusCode : "unknown"));
    }
  }
}, $apis.requireAuth());

// ---- POST /api/orders/{id}/complete (admin) ----
routerAdd("POST", "/api/orders/{id}/complete", function(e){
  function num(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return n;
  }
  var admin = false;
  try { admin = !!e.auth && (e.auth.isSuperuser() || e.auth.collection().name === "admins"); }
  catch (errA) { admin = false; }
  if (!admin) throw new ForbiddenError("Hanya admin yang dapat melakukan aksi ini.");

  var orderId = e.request.pathValue("id");
  var result = {};
  $app.runInTransaction(function(txApp){
    var orderRec = null;
    try {
      orderRec = txApp.findRecordById("orders", orderId);
    } catch (errB) {
      throw new NotFoundError("Order tidak ditemukan.");
    }
    if (orderRec.getString("status") !== "Pending") {
      throw new BadRequestError("Hanya order Pending yang dapat di-complete.");
    }
    // Duplicate protection: exactly one CASH_IN and one OUT SALE per order.
    var dup = null;
    try {
      dup = txApp.findFirstRecordByFilter(
        "cash_transactions", "order = {:o} && type = 'CASH_IN'", { o: orderId }
      );
    } catch (errC) { dup = null; }
    if (dup) throw new BadRequestError("Cash IN untuk order ini sudah tercatat.");
    var dupMov = null;
    try {
      dupMov = txApp.findFirstRecordByFilter(
        "stock_movements", "order = {:o} && type = 'OUT' && source = 'SALE'", { o: orderId }
      );
    } catch (errC2) { dupMov = null; }
    if (dupMov) throw new BadRequestError("Inventory SALE untuk order ini sudah tercatat.");

    // NOTE: signature is (collection, filter, sort, limit, offset, ...params).
    var lines = txApp.findRecordsByFilter("order_items", "order = {:o}", "", 500, 0, { o: orderId });
    if (!lines || lines.length === 0) throw new BadRequestError("Order tidak memiliki item.");

    var orderTotal = num(orderRec.get("total"), 0);
    // Aggregate per catalog (defensive: separate models per line would lose
    // writes if lines ever shared a catalog).
    var qtyByCat = {};
    for (var i = 0; i < lines.length; i++) {
      var ccid = lines[i].getString("catalog");
      qtyByCat[ccid] = (qtyByCat[ccid] || 0) + num(lines[i].get("quantity"), 0);
    }
    for (var cidC in qtyByCat) {
      var cat = txApp.findRecordById("catalog", cidC);
      var newReserved = num(cat.get("reserved_stock"), 0) - qtyByCat[cidC];
      var newStock = num(cat.get("stock"), 0) - qtyByCat[cidC];
      if (newReserved < 0 || newStock < 0) {
        throw new BadRequestError("Stock '" + cat.getString("name") + "' tidak konsisten untuk complete.");
      }
      cat.set("reserved_stock", newReserved);
      cat.set("stock", newStock);
      txApp.save(cat);
    }

    orderRec.set("status", "Completed");
    orderRec.set("completed_at", new Date().toISOString());
    txApp.save(orderRec);

    var cashCol = txApp.findCollectionByNameOrId("cash_transactions");
    var cash = new Record(cashCol);
    cash.set("type", "CASH_IN");
    cash.set("amount", orderTotal);
    cash.set("note", "Order " + orderId + " completed");
    cash.set("order", orderId);
    txApp.save(cash);

    // Inventory OUT SALE history for the SAME deduction above (no second
    // stock change here). One movement per completed order, items mirror
    // the order_items price snapshots.
    var movCol = txApp.findCollectionByNameOrId("stock_movements");
    var saleMov = new Record(movCol);
    saleMov.set("type", "OUT");
    saleMov.set("source", "SALE");
    saleMov.set("status", "Completed");
    saleMov.set("order", orderId);
    saleMov.set("total_cost", orderTotal);
    saleMov.set("note", "Order " + orderId + " completed");
    txApp.save(saleMov);
    var saleItemCol = txApp.findCollectionByNameOrId("stock_movement_items");
    for (var s = 0; s < lines.length; s++) {
      var sItem = new Record(saleItemCol);
      sItem.set("movement", saleMov.id);
      sItem.set("catalog", lines[s].getString("catalog"));
      sItem.set("quantity", num(lines[s].get("quantity"), 0));
      sItem.set("unit_cost", num(lines[s].get("unit_price"), 0));
      sItem.set("subtotal", num(lines[s].get("quantity"), 0) * num(lines[s].get("unit_price"), 0));
      txApp.save(sItem);
    }

    var completedAt = orderRec.get("completed_at");
    result = {
      id: orderRec.id,
      user: orderRec.getString("user"),
      in_game_name: orderRec.getString("in_game_name"),
      in_game_phone: orderRec.getString("in_game_phone"),
      notes: orderRec.getString("notes"),
      status: orderRec.getString("status"),
      total: num(orderRec.get("total"), 0),
      completed_at: completedAt ? String(completedAt) : null,
    };
  });
  return e.json(200, result);
}, $apis.requireAuth());

// ---- POST /api/orders/{id}/cancel (admin) ----
routerAdd("POST", "/api/orders/{id}/cancel", function(e){
  function num(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return n;
  }
  var admin = false;
  try { admin = !!e.auth && (e.auth.isSuperuser() || e.auth.collection().name === "admins"); }
  catch (errA) { admin = false; }
  if (!admin) throw new ForbiddenError("Hanya admin yang dapat melakukan aksi ini.");

  var orderId = e.request.pathValue("id");
  var result = {};
  $app.runInTransaction(function(txApp){
    var orderRec = null;
    try {
      orderRec = txApp.findRecordById("orders", orderId);
    } catch (errB) {
      throw new NotFoundError("Order tidak ditemukan.");
    }
    if (orderRec.getString("status") !== "Pending") {
      throw new BadRequestError("Hanya order Pending yang dapat di-cancel.");
    }
    // NOTE: signature is (collection, filter, sort, limit, offset, ...params).
    var lines = txApp.findRecordsByFilter("order_items", "order = {:o}", "", 500, 0, { o: orderId });
    // Aggregate per catalog (defensive; see complete route note).
    var relByCat = {};
    for (var i = 0; i < lines.length; i++) {
      var ccid = lines[i].getString("catalog");
      relByCat[ccid] = (relByCat[ccid] || 0) + num(lines[i].get("quantity"), 0);
    }
    for (var cidR in relByCat) {
      var cat = txApp.findRecordById("catalog", cidR);
      var newReserved = num(cat.get("reserved_stock"), 0) - relByCat[cidR];
      if (newReserved < 0) throw new BadRequestError("Reserved stock '" + cat.getString("name") + "' tidak konsisten untuk cancel.");
      cat.set("reserved_stock", newReserved);
      txApp.save(cat);
    }
    // No stock change, no CASH_IN, completed_at stays empty. Weekly usage is
    // derived from Pending/Completed orders, so Cancelled releases it.
    orderRec.set("status", "Cancelled");
    txApp.save(orderRec);
    var completedAt = orderRec.get("completed_at");
    result = {
      id: orderRec.id,
      user: orderRec.getString("user"),
      in_game_name: orderRec.getString("in_game_name"),
      in_game_phone: orderRec.getString("in_game_phone"),
      notes: orderRec.getString("notes"),
      status: orderRec.getString("status"),
      total: num(orderRec.get("total"), 0),
      completed_at: completedAt ? String(completedAt) : null,
    };
  });
  return e.json(200, result);
}, $apis.requireAuth());

// ---- POST /api/inventory/in — Barang Masuk (admin, multi-item, atomic) ----
routerAdd("POST", "/api/inventory/in", function(e){
  function num(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return n;
  }
  var admin = false;
  try { admin = !!e.auth && (e.auth.isSuperuser() || e.auth.collection().name === "admins"); }
  catch (errA) { admin = false; }
  if (!admin) throw new ForbiddenError("Hanya admin yang dapat melakukan aksi ini.");

  var body = e.requestInfo().body || {};
  var result = {};
  $app.runInTransaction(function(txApp){
    var supName = String(body.supplier_name || "").trim();
    var reference = String(body.reference || "").trim();
    var note = String(body.note || "");
    if (!supName) throw new BadRequestError("Supplier wajib diisi.");
    if (supName.length > 255) throw new BadRequestError("Supplier maksimal 255 karakter.");
    if (reference.length > 255) throw new BadRequestError("Reference maksimal 255 karakter.");
    if (note.length > 1000) throw new BadRequestError("Catatan maksimal 1000 karakter.");
    var rawItems = body.items;
    if (!rawItems || !(rawItems instanceof Array) || rawItems.length === 0) {
      throw new BadRequestError("Items tidak boleh kosong.");
    }
    if (rawItems.length > 100) throw new BadRequestError("Terlalu banyak item.");

    // Validate ALL lines before writing anything (all-or-nothing).
    var prepared = [];
    var total = 0;
    for (var i = 0; i < rawItems.length; i++) {
      var line = rawItems[i] || {};
      var cid = String(line.catalog || "");
      var q = Number(line.quantity);
      var uc = Number(line.unit_cost);
      if (!cid) throw new BadRequestError("Catalog wajib dipilih.");
      if (!Number.isInteger(q) || q < 1) throw new BadRequestError("Quantity harus integer >= 1.");
      if (!Number.isInteger(uc) || uc < 0) throw new BadRequestError("Unit cost harus integer >= 0.");
      var cat = null;
      try {
        cat = txApp.findRecordById("catalog", cid);
      } catch (errB) {
        throw new BadRequestError("Catalog tidak ditemukan.");
      }
      total += q * uc;
      prepared.push({ cat: cat, qty: q, unitCost: uc });
    }

    var movCol = txApp.findCollectionByNameOrId("stock_movements");
    var mov = new Record(movCol);
    mov.set("type", "IN");
    mov.set("source", "SUPPLIER");
    mov.set("status", "Active");
    mov.set("supplier_name", supName);
    if (reference) mov.set("reference", reference);
    if (note) mov.set("note", note);
    mov.set("total_cost", total);
    txApp.save(mov);

    var itemCol = txApp.findCollectionByNameOrId("stock_movement_items");
    var outItems = [];
    // Aggregate per catalog: several lines may share one catalog, and each
    // findRecordById returns a separate model, so per-line read-modify-write
    // would lose all but the last line (last write wins).
    var addByCatalog = {};
    var nameByCatalog = {};
    for (var p = 0; p < prepared.length; p++) {
      var it = new Record(itemCol);
      it.set("movement", mov.id);
      it.set("catalog", prepared[p].cat.id);
      it.set("quantity", prepared[p].qty);
      it.set("unit_cost", prepared[p].unitCost);
      it.set("subtotal", prepared[p].qty * prepared[p].unitCost);
      txApp.save(it);
      addByCatalog[prepared[p].cat.id] = (addByCatalog[prepared[p].cat.id] || 0) + prepared[p].qty;
      nameByCatalog[prepared[p].cat.id] = prepared[p].cat.getString("name");
      outItems.push({
        id: it.id,
        catalog: prepared[p].cat.id,
        catalog_name: prepared[p].cat.getString("name"),
        quantity: prepared[p].qty,
        unit_cost: prepared[p].unitCost,
        subtotal: prepared[p].qty * prepared[p].unitCost,
      });
    }
    for (var cidU in addByCatalog) {
      var catU = txApp.findRecordById("catalog", cidU);
      catU.set("stock", num(catU.get("stock"), 0) + addByCatalog[cidU]);
      txApp.save(catU);
    }

    // Ledger: CASH_OUT of total_cost (may legitimately be 0 — still recorded).
    var cashCol = txApp.findCollectionByNameOrId("cash_transactions");
    var cash = new Record(cashCol);
    cash.set("type", "CASH_OUT");
    cash.set("amount", total);
    cash.set("note", "Barang masuk " + supName);
    cash.set("stock_movement", mov.id);
    txApp.save(cash);

    result = {
      id: mov.id,
      type: "IN",
      source: "SUPPLIER",
      status: "Active",
      supplier_name: supName,
      reference: reference,
      note: note,
      total_cost: total,
      items: outItems,
    };
  });
  return e.json(200, result);
}, $apis.requireAuth());

// ---- POST /api/inventory/out-manual — Barang Keluar manual (admin, atomic) ----
routerAdd("POST", "/api/inventory/out-manual", function(e){
  function num(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return n;
  }
  var admin = false;
  try { admin = !!e.auth && (e.auth.isSuperuser() || e.auth.collection().name === "admins"); }
  catch (errA) { admin = false; }
  if (!admin) throw new ForbiddenError("Hanya admin yang dapat melakukan aksi ini.");

  var body = e.requestInfo().body || {};
  var result = {};
  $app.runInTransaction(function(txApp){
    var reason = String(body.reason || "").trim();
    var reference = String(body.reference || "").trim();
    var note = String(body.note || "");
    var allowed = { RUSAK: 1, HILANG: 1, DIPAKAI_INTERNAL: 1, DIBERIKAN: 1, PENYESUAIAN: 1, LAINNYA: 1 };
    if (!allowed[reason]) throw new BadRequestError("Reason tidak valid.");
    if (reference.length > 255) throw new BadRequestError("Reference maksimal 255 karakter.");
    if (note.length > 1000) throw new BadRequestError("Catatan maksimal 1000 karakter.");
    var rawItems = body.items;
    if (!rawItems || !(rawItems instanceof Array) || rawItems.length === 0) {
      throw new BadRequestError("Items tidak boleh kosong.");
    }
    if (rawItems.length > 100) throw new BadRequestError("Terlalu banyak item.");

    // Manual OUT respects reservations: quantity <= stock - reserved_stock.
    var prepared = [];
    for (var i = 0; i < rawItems.length; i++) {
      var line = rawItems[i] || {};
      var cid = String(line.catalog || "");
      var q = Number(line.quantity);
      if (!cid) throw new BadRequestError("Catalog wajib dipilih.");
      if (!Number.isInteger(q) || q < 1) throw new BadRequestError("Quantity harus integer >= 1.");
      var cat = null;
      try {
        cat = txApp.findRecordById("catalog", cid);
      } catch (errB) {
        throw new BadRequestError("Catalog tidak ditemukan.");
      }
      var available = num(cat.get("stock"), 0) - num(cat.get("reserved_stock"), 0);
      if (q > available) {
        throw new BadRequestError("Stock '" + cat.getString("name") + "' tidak cukup (tersisa " + Math.max(0, available) + ").");
      }
      prepared.push({ cat: cat, qty: q });
    }

    var movCol = txApp.findCollectionByNameOrId("stock_movements");
    var mov = new Record(movCol);
    mov.set("type", "OUT");
    mov.set("source", "MANUAL");
    mov.set("status", "Active");
    mov.set("reason", reason);
    if (reference) mov.set("reference", reference);
    if (note) mov.set("note", note);
    mov.set("total_cost", 0);
    txApp.save(mov);

    var itemCol = txApp.findCollectionByNameOrId("stock_movement_items");
    var outItems = [];
    // Same-catalog lines share one stock write (see IN route note).
    var subByCatalog = {};
    for (var p = 0; p < prepared.length; p++) {
      var it = new Record(itemCol);
      it.set("movement", mov.id);
      it.set("catalog", prepared[p].cat.id);
      it.set("quantity", prepared[p].qty);
      it.set("unit_cost", 0);
      it.set("subtotal", 0);
      txApp.save(it);
      subByCatalog[prepared[p].cat.id] = (subByCatalog[prepared[p].cat.id] || 0) + prepared[p].qty;
      outItems.push({
        id: it.id,
        catalog: prepared[p].cat.id,
        catalog_name: prepared[p].cat.getString("name"),
        quantity: prepared[p].qty,
        unit_cost: 0,
        subtotal: 0,
      });
    }
    for (var cidS in subByCatalog) {
      var catS = txApp.findRecordById("catalog", cidS);
      catS.set("stock", num(catS.get("stock"), 0) - subByCatalog[cidS]);
      txApp.save(catS);
    }
    // No cash movement for manual OUT.

    result = {
      id: mov.id,
      type: "OUT",
      source: "MANUAL",
      status: "Active",
      reason: reason,
      reference: reference,
      note: note,
      total_cost: 0,
      items: outItems,
    };
  });
  return e.json(200, result);
}, $apis.requireAuth());

// ---- POST /api/inventory/{id}/cancel — void IN / MANUAL OUT (admin) ----
routerAdd("POST", "/api/inventory/{id}/cancel", function(e){
  function num(v, dflt) {
    var n = Number(v);
    if (!isFinite(n)) return dflt;
    return n;
  }
  var admin = false;
  try { admin = !!e.auth && (e.auth.isSuperuser() || e.auth.collection().name === "admins"); }
  catch (errA) { admin = false; }
  if (!admin) throw new ForbiddenError("Hanya admin yang dapat melakukan aksi ini.");

  var movementId = e.request.pathValue("id");
  var result = {};
  $app.runInTransaction(function(txApp){
    var mov = null;
    try {
      mov = txApp.findRecordById("stock_movements", movementId);
    } catch (errB) {
      throw new NotFoundError("Movement tidak ditemukan.");
    }
    // Sale movements follow the Order lifecycle — never void via Inventory.
    if (mov.getString("source") === "SALE") {
      throw new BadRequestError("Penjualan tidak dapat di-void melalui Inventory.");
    }
    if (mov.getString("status") === "Cancelled") throw new BadRequestError("Movement sudah dibatalkan.");
    if (mov.getString("status") !== "Active") throw new BadRequestError("Hanya movement Active yang dapat dibatalkan.");

    var lines = txApp.findRecordsByFilter("stock_movement_items", "movement = {:m}", "", 500, 0, { m: movementId });
    var isIn = mov.getString("type") === "IN";

    // Aggregate per catalog first (lines may share a catalog; separate
    // models would lose all but one write), then pre-validate the totals so
    // the reversal can never corrupt stock. IN reversal must keep
    // stock >= 0 AND stock >= reserved_stock.
    var qtyByCatalog = {};
    for (var i = 0; i < lines.length; i++) {
      var cc = lines[i].getString("catalog");
      qtyByCatalog[cc] = (qtyByCatalog[cc] || 0) + num(lines[i].get("quantity"), 0);
    }
    var deltas = [];
    for (var cidR in qtyByCatalog) {
      var cat = txApp.findRecordById("catalog", cidR);
      var q = qtyByCatalog[cidR];
      if (isIn) {
        var ns = num(cat.get("stock"), 0) - q;
        if (ns < 0 || ns < num(cat.get("reserved_stock"), 0)) {
          throw new BadRequestError("Stock '" + cat.getString("name") + "' tidak cukup untuk membatalkan movement ini.");
        }
        deltas.push({ cat: cat, next: ns });
      } else {
        deltas.push({ cat: cat, next: num(cat.get("stock"), 0) + q });
      }
    }
    for (var d = 0; d < deltas.length; d++) {
      deltas[d].cat.set("stock", deltas[d].next);
      txApp.save(deltas[d].cat);
    }
    mov.set("status", "Cancelled");
    txApp.save(mov);

    // IN reversal: original CASH_OUT is immutable; record CASH_IN reversal.
    // MANUAL OUT touches no cash.
    if (isIn) {
      var cashCol = txApp.findCollectionByNameOrId("cash_transactions");
      var cash = new Record(cashCol);
      cash.set("type", "CASH_IN");
      cash.set("amount", num(mov.get("total_cost"), 0));
      cash.set("note", "Reversal barang masuk " + movementId);
      cash.set("stock_movement", movementId);
      txApp.save(cash);
    }

    result = { id: mov.id, status: "Cancelled" };
  });
  return e.json(200, result);
}, $apis.requireAuth());

// ---- GET /api/cash/balance (admin) ----
// Derived balance: SUM(CASH_IN) - SUM(CASH_OUT). No stored balance field.
routerAdd("GET", "/api/cash/balance", function(e){
  var admin = false;
  try { admin = !!e.auth && (e.auth.isSuperuser() || e.auth.collection().name === "admins"); }
  catch (errA) { admin = false; }
  if (!admin) throw new ForbiddenError("Hanya admin yang dapat melihat cash ledger.");

  var cin = new DynamicModel({ total: 0, count: 0 });
  $app.db().newQuery(
    "SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM cash_transactions WHERE type = {:t}"
  ).bind({ t: "CASH_IN" }).one(cin);
  var cout = new DynamicModel({ total: 0, count: 0 });
  $app.db().newQuery(
    "SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM cash_transactions WHERE type = {:t}"
  ).bind({ t: "CASH_OUT" }).one(cout);
  var inTotal = Number(cin.total) || 0;
  var outTotal = Number(cout.total) || 0;
  return e.json(200, {
    cashIn: inTotal,
    cashOut: outTotal,
    balance: inTotal - outTotal,
    countIn: Number(cin.count) || 0,
    countOut: Number(cout.count) || 0,
  });
}, $apis.requireAuth());

// ---- GET /api/orders/{id}/detail (owner or admin, read-only) ----
// Users cannot expand the base catalog collection (admin-only rules), and the
// public view hides inactive items — yet history must show item names
// including inactive ones, without leaking stock/price/limits. This endpoint
// resolves ONLY {id, name} per line server-side through the DAO.
// Ownership is enforced here manually because DAO access bypasses API rules:
// a users-auth caller receives another gank's order as 404 (no oracle).
routerAdd("GET", "/api/orders/{id}/detail", function(e){
  var admin = false;
  var me = "";
  var isUser = false;
  try {
    admin = !!e.auth && (e.auth.isSuperuser() || e.auth.collection().name === "admins");
  } catch (errA) { admin = false; }
  if (!e.auth) throw new ForbiddenError("Login diperlukan.");
  if (!admin) {
    try {
      if (e.auth.collection().name !== "users") throw new ForbiddenError("Login diperlukan.");
      isUser = true;
      me = e.auth.id;
    } catch (errB) { throw new ForbiddenError("Login diperlukan."); }
  }

  var orderId = e.request.pathValue("id");
  var orderRec = null;
  try {
    orderRec = $app.findRecordById("orders", orderId);
  } catch (errC) {
    throw new NotFoundError("Pesanan tidak ditemukan.");
  }
  if (isUser && orderRec.getString("user") !== me) {
    throw new NotFoundError("Pesanan tidak ditemukan.");
  }
  var lines = $app.findRecordsByFilter("order_items", "order = {:o}", "", 500, 0, { o: orderId });
  var items = [];
  for (var i = 0; i < lines.length; i++) {
    var catId = lines[i].getString("catalog");
    var cname = "";
    try {
      cname = $app.findRecordById("catalog", catId).getString("name");
    } catch (errD) { cname = ""; }
    var q = lines[i].get("quantity");
    var up = lines[i].get("unit_price");
    items.push({
      id: lines[i].id,
      order: orderId,
      catalog: catId,
      catalog_name: cname,
      quantity: Number(q) || 0,
      unit_price: Number(up) || 0,
    });
  }
  var completedAt = orderRec.get("completed_at");
  return e.json(200, {
    order: {
      id: orderRec.id,
      status: orderRec.getString("status"),
      total: Number(orderRec.get("total")) || 0,
      in_game_name: orderRec.getString("in_game_name"),
      in_game_phone: orderRec.getString("in_game_phone"),
      notes: orderRec.getString("notes"),
      completed_at: completedAt ? String(completedAt) : null,
    },
    items: items,
  });
}, $apis.requireAuth());

// ---- API-rule guards: block direct client writes that would bypass validation ----
// (DAO writes from the routes above do not trigger these request hooks.
// These guards are self-contained on purpose — see the scoping note on top.)

onRecordCreateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Order harus dibuat melalui Checkout.");
}, "orders");

onRecordUpdateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  var orig = e.record.original();
  if (e.record.getString("status") !== orig.getString("status")) {
    throw new BadRequestError("Status order hanya dapat diubah melalui Complete/Cancel.");
  }
  if (String(e.record.get("total")) !== String(orig.get("total"))) {
    throw new BadRequestError("Total order tidak dapat diubah.");
  }
  if (String(e.record.get("completed_at") || "") !== String(orig.get("completed_at") || "")) {
    throw new BadRequestError("completed_at tidak dapat diubah langsung.");
  }
  if (e.record.getString("user") !== orig.getString("user")) {
    throw new BadRequestError("User order tidak dapat diubah.");
  }
  // notes / in_game_* contact corrections remain editable by admin.
  e.next();
}, "orders");

onRecordDeleteRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Order tidak dapat dihapus.");
}, "orders");

onRecordCreateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Order item dibuat otomatis saat Checkout.");
}, "order_items");

onRecordUpdateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Order item tidak dapat diubah (cancel order lalu buat baru).");
}, "order_items");

onRecordDeleteRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Order item tidak dapat dihapus.");
}, "order_items");

onRecordCreateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Supplier entry harus dibuat melalui aksi Supplier Stock.");
}, "supplier_stock_entries");

onRecordUpdateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Supplier entry tidak dapat diubah (cancel lalu buat baru).");
}, "supplier_stock_entries");

onRecordDeleteRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Supplier entry tidak dapat dihapus.");
}, "supplier_stock_entries");

onRecordCreateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Stock movement harus dibuat melalui aksi Inventory.");
}, "stock_movements");

onRecordUpdateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Stock movement tidak dapat diubah (batalkan lalu buat baru).");
}, "stock_movements");

onRecordDeleteRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Stock movement tidak dapat dihapus.");
}, "stock_movements");

onRecordCreateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Movement item dibuat otomatis bersama movement.");
}, "stock_movement_items");

onRecordUpdateRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Movement item tidak dapat diubah.");
}, "stock_movement_items");

onRecordDeleteRequest(function(e){
  if (e.hasSuperuserAuth()) return e.next();
  throw new BadRequestError("Movement item tidak dapat dihapus.");
}, "stock_movement_items");
