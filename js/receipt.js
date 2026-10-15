// Builds a receipt-style PDF (80mm wide, like a thermal slip) with jsPDF.
// trip = { mode: 'map' | 'meter' | 'distance', vehicleName, from, to, startMeter, endMeter, distanceKm, mins, waitingMins, tripType, passenger, date }

// jsPDF's built-in font only supports basic Latin characters
function pdfSafe(str) {
  return String(str ?? '')
    .replace(/[—–]/g, '-')
    .replace(/±/g, '+/-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// e.g. CAR-20261011-184614 / MCA-…: vehicle type code + date + time
function receiptNumber(d, vehicleName) {
  const p = (n) => String(n).padStart(2, '0');
  // one word: its first 3 letters (TUK, CAR, VAN); more words: their initials + the rest of the last word (MCA, MVA, MBU)
  const words = String(vehicleName || '').replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const code = (words.length > 1 ? words.map((w) => w[0]).join('') + words[words.length - 1].slice(1) : words.join(''))
    .slice(0, 3).toUpperCase() || 'TR';
  return `${code}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function createReceiptPdf(trip, s = loadSettings()) {
  const { jsPDF } = window.jspdf;
  const W = 80;        // page width (mm)
  const M = 6;         // side margin
  const f = calculateFare(trip.distanceKm, s, trip.waitingMins, trip.tripType);
  const money = (v) => pdfSafe(formatMoney(v, s));

  // Runs twice: first to measure the height, then to actually draw.
  const render = (doc, draw) => {
    let y = 10;

    const font = (size, bold) => { doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); };
    const center = (str, size, bold) => {
      font(size, bold);
      if (draw) doc.text(pdfSafe(str), W / 2, y, { align: 'center' });
      y += size * 0.45;
    };
    // centred text that wraps onto more lines when it is too wide (business name, second line)
    const centerWrap = (str, size, bold) => {
      font(size, bold);
      doc.splitTextToSize(pdfSafe(str), W - 2 * M).forEach((ln) => {
        if (draw) doc.text(ln, W / 2, y, { align: 'center' });
        y += size * 0.45;
      });
    };
    const divider = () => {
      y += 1;
      if (draw) {
        doc.setLineDashPattern([1, 1], 0);
        doc.setDrawColor(150);
        doc.line(M, y, W - M, y);
      }
      y += 5;
    };
    // label on the left, value on the right (value wraps if long)
    const row = (label, value, bold = false, size = 9) => {
      font(size, bold);
      const lines = doc.splitTextToSize(pdfSafe(value), W - 2 * M - 26);
      if (draw) {
        doc.text(pdfSafe(label), M, y);
        lines.forEach((ln, i) => doc.text(ln, W - M, y + i * 4, { align: 'right' }));
      }
      y += lines.length * 4 + 1;
    };
    // label on its own line, then full-width wrapped value (for addresses)
    const block = (label, value) => {
      font(8, true);
      if (draw) doc.text(pdfSafe(label), M, y);
      y += 4;
      font(9, false);
      const lines = doc.splitTextToSize(pdfSafe(value) || '-', W - 2 * M);
      if (draw) doc.text(lines, M, y);
      y += lines.length * 4 + 1.5;
    };

    // Header: the rider's business name (Admin → Receipt details), else "TukTuk Rider"
    const title = pdfSafe(s.receiptTitle) || 'TukTuk Rider';
    centerWrap(title, title.length > 20 ? 13 : 16, true);
    if (pdfSafe(s.receiptSubtitle)) centerWrap(s.receiptSubtitle, 8, false);
    y += 1;
    center('TRIP RECEIPT', 9, false);
    if (s.driverName) center(`Driver: ${s.driverName}`, 8, false);
    if (s.vehicleNo) center(`Vehicle No: ${s.vehicleNo}`, 8, false);
    if (s.driverPhone) center(`Tel: ${s.driverPhone}`, 8, false);
    divider();

    // Receipt info
    const d = trip.date;
    row('Receipt No', receiptNumber(d, trip.vehicleName));
    row('Date', d.toLocaleDateString('en-GB'));
    row('Time', d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
    if (pdfSafe(trip.passenger)) row('Passenger', trip.passenger);
    divider();

    // Trip
    if (trip.vehicleName) row('Vehicle type', trip.vehicleName);
    row('Trip', TRIP_TYPES[f.tripType].name);
    if (trip.mode === 'map') {
      block('FROM', trip.from);
      block('TO', trip.to);
      row('Method', 'Map route');
    } else if (trip.mode === 'distance') {
      row('Method', 'Distance entered');
    } else {
      row('Method', 'Meter reading');
      row('Start meter', `${trip.startMeter} km`);
      row('End meter', `${trip.endMeter} km`);
    }
    row('Distance', `${trip.distanceKm.toFixed(2)} km`);
    if (s.roundUpKm) row('Charged as', `${f.km} km`);
    if (trip.mins) row('Travel time', `~${trip.mins} min`);
    if (f.waitMins) row('Waiting time', formatWaiting(f.waitMins));
    divider();

    // Fare breakdown
    row(`${f.km.toFixed(2)} km x ${money(f.perKmRate)}`, money(f.kmPart.toFixed(2)));
    if (f.minimumApplied) row('Minimum fare applied', money(f.minimumFare));
    if (f.waitMins && f.billedMins !== f.waitMins) row('Waiting charged', formatWaiting(f.billedMins));
    if (f.waitMins) row(`Waiting (${money(f.waitRate)}/hour)`, money(f.waitingPart.toFixed(2)));
    row('Exact amount', money(f.exact.toFixed(2)));
    if (f.exact !== f.total) {
      row(`Rounding (${roundingText(s).replace('rounded ', '')})`,
        `${f.exact > f.total ? '-' : '+'} ${money(Math.abs(f.exact - f.total).toFixed(2))}`);
    }
    divider();

    // Total
    row('TOTAL', money(f.total), true, 13);
    if (trip.plusToll) row('+ Expressway toll', 'paid on top');
    y += 1;
    divider();

    center('Thank you for riding with us!', 9, false);
    y += 1;
    if (draw) doc.setTextColor(120);
    center('Developed by Team TGA', 7, false);
    if (draw) doc.setTextColor(0);

    return y + 4;
  };

  const height = render(new jsPDF({ unit: 'mm', format: [W, 600] }), false);
  const doc = new jsPDF({ unit: 'mm', format: [W, Math.max(height, 90)] });
  render(doc, true);

  return { doc, fileName: `${receiptNumber(trip.date, trip.vehicleName)}.pdf` };
}
