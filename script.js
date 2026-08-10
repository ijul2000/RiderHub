let pendingPayload = null;
    let pendingActionType = '';
    let chartPlatformBar;
    let masterCachedHistoryLogs = [];
    let lastFilteredLogs = []; // BARU: simpan senarai terkini yang dah difilter, dipakai oleh modal "Lihat Semua"

    // ================== API HELPER (GitHub Pages -> Google Apps Script Web App) ==================
    // API_URL ditakrifkan dalam index.html (sebelum <script src="script.js">)
    function apiGet(action) {
      return fetch(API_URL + "?action=" + encodeURIComponent(action))
        .then(function(res) { return res.json(); });
    }

    function apiPost(action, payload) {
      // Guna Content-Type: text/plain supaya browser tak hantar CORS preflight (OPTIONS),
      // sebab Google Apps Script Web App tak sokong preflight dengan baik.
      return fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ action: action, payload: payload })
      }).then(function(res) { return res.json(); });
    }
    // ================================================================================

    const PREVIEW_LIMIT = 5; // BARU: berapa banyak entri dipaparkan sebagai preview kat resit utama

    const monthNames = ["", "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December"]; // BARU: untuk label period dalam modal

    window.addEventListener('load', function(){
      var now = new Date();
      document.getElementById('lblPrintedOn').innerText =
        String(now.getDate()).padStart(2,'0') + " / " + String(now.getMonth()+1).padStart(2,'0') + " / " + now.getFullYear();
      restoreFilterMonth();
      loadSheetTotals();
    });

    function saveFilterSelection() {
      const month = document.getElementById('mainFilterMonth').value;
      const year = document.getElementById('mainFilterYear').value;
      const platform = document.getElementById('mainFilterPlatform').value;
      localStorage.setItem('riderhub_filterMonth', month);
      localStorage.setItem('riderhub_filterYear', year);
      localStorage.setItem('riderhub_filterPlatform', platform);
    }

    function restoreFilterMonth() {
      const savedMonth = localStorage.getItem('riderhub_filterMonth');
      if (savedMonth) document.getElementById('mainFilterMonth').value = savedMonth;
      const savedPlatform = localStorage.getItem('riderhub_filterPlatform');
      if (savedPlatform) document.getElementById('mainFilterPlatform').value = savedPlatform;
    }

    function loadSheetTotals() {
      apiGet("getDashboardData").then(function(res) {
        if(res.error) { showToast(res.error, "error"); return; }
        masterCachedHistoryLogs = res.history || [];
        buildYearFilterDropdowns();
        syncDashboardCalculations();
      }).catch(function(err) {
        showToast("Failed to load data: " + err, "error");
      });
    }

    function syncDashboardCalculations() {
      const selectedMonth = document.getElementById('mainFilterMonth').value;
      const selectedYear = document.getElementById('mainFilterYear').value;
      const selectedPlatform = document.getElementById('mainFilterPlatform').value;

      // Step 1: tapis ikut month/year sahaja dulu — platform dikendali berasingan ikut jenis kad di bawah
      let periodLogs = masterCachedHistoryLogs.filter(log => {
        if (selectedMonth !== "ALL" && String(log.month) !== selectedMonth) return false;
        if (selectedYear !== "ALL" && String(log.year) !== selectedYear) return false;
        return true;
      });

      let uniqueWorkingDates = {};
      let filteredLogs;
      let tipsSum = 0, fuelSum = 0, lainSum = 0, hoursSum = 0;
      let grabEarningSum = 0, shopeeEarningSum = 0, lalamoveEarningSum = 0, foodpandaEarningSum = 0;
      let grabHoursSum = 0, shopeeHoursSum = 0, lalamoveHoursSum = 0, foodpandaHoursSum = 0;
      let netEarningResult = 0, totalExpenseSum = 0;
      let remainingSaving = 0, remainingLoan = 0;
      let showBlankExpenseAllocation = false;

      if (selectedPlatform === "ALL") {
        // ---- PAPARAN ALL PLATFORMS (kekal seperti asal) ----
        let rawNetEarningSum = 0, savingExpenseSum = 0, loanExpenseSum = 0;

        filteredLogs = periodLogs.filter(log => {
          if (log.type === "Deposit") uniqueWorkingDates[log.date] = true;
          return true;
        });

        filteredLogs.forEach(log => {
          rawNetEarningSum += log.netEarningRaw;
          tipsSum += log.tipsRaw;
          fuelSum += log.fuelRaw;
          savingExpenseSum += log.savingRaw;
          loanExpenseSum += log.loanRaw;
          lainSum += log.lainRaw || 0;
          hoursSum += log.hoursWorked || 0;

          if (log.type === "Deposit") {
            if (log.category === "GrabFood") { grabEarningSum += log.grossRaw; grabHoursSum += log.hoursWorked || 0; }
            else if (log.category === "ShopeeFood") { shopeeEarningSum += log.grossRaw; shopeeHoursSum += log.hoursWorked || 0; }
            else if (log.category === "Lalamove") { lalamoveEarningSum += log.grossRaw; lalamoveHoursSum += log.hoursWorked || 0; }
            else if (log.category === "FoodPanda") { foodpandaEarningSum += log.grossRaw; foodpandaHoursSum += log.hoursWorked || 0; }
          }
        });

        let baseAllocation = rawNetEarningSum - fuelSum - lainSum;
        remainingSaving = (baseAllocation * 0.30) - savingExpenseSum;
        remainingLoan = (baseAllocation * 0.70) - loanExpenseSum;

        totalExpenseSum = fuelSum + savingExpenseSum + loanExpenseSum + lainSum;
        netEarningResult = rawNetEarningSum + tipsSum - totalExpenseSum;

      } else {
        // ---- PAPARAN IKUT PLATFORM (GrabFood / ShopeeFood / Lalamove) ----
        showBlankExpenseAllocation = true;

        periodLogs.forEach(log => {
          if (log.type === "Deposit" && log.category === selectedPlatform) {
            netEarningResult += log.netEarningRaw + log.tipsRaw;
            tipsSum += log.tipsRaw;
            hoursSum += log.hoursWorked || 0;
            uniqueWorkingDates[log.date] = true;
            if (log.category === "GrabFood") { grabEarningSum += log.grossRaw; grabHoursSum += log.hoursWorked || 0; }
            else if (log.category === "ShopeeFood") { shopeeEarningSum += log.grossRaw; shopeeHoursSum += log.hoursWorked || 0; }
            else if (log.category === "Lalamove") { lalamoveEarningSum += log.grossRaw; lalamoveHoursSum += log.hoursWorked || 0; }
            else if (log.category === "FoodPanda") { foodpandaEarningSum += log.grossRaw; foodpandaHoursSum += log.hoursWorked || 0; }
          }
        });

        // Transaction log ikut platform: deposit platform terpilih sahaja
        filteredLogs = periodLogs.filter(log => log.type === "Deposit" && log.category === selectedPlatform);
      }

      lastFilteredLogs = filteredLogs; // BARU: simpan untuk dipakai oleh modal "Lihat Semua"

      document.getElementById('lblWorkingDays').innerText = Object.keys(uniqueWorkingDates).length + " Days";
      document.getElementById('lblWorkingHour').innerText = formatHoursToHM(hoursSum);

      document.getElementById('lblNetEarning').innerText = "RM " + netEarningResult.toFixed(2);
      document.getElementById('lblTips').innerText = "RM " + tipsSum.toFixed(2);
      document.getElementById('lblExpenses').innerText = showBlankExpenseAllocation ? "-" : ("RM " + totalExpenseSum.toFixed(2));
      document.getElementById('lblSaving').innerText = showBlankExpenseAllocation ? "-" : ("RM " + remainingSaving.toFixed(2));
      document.getElementById('lblLoan').innerText = showBlankExpenseAllocation ? "-" : ("RM " + remainingLoan.toFixed(2));

      // BARU: preview terhad di resit utama
      document.getElementById('historyList').innerHTML = buildHistoryHtml(filteredLogs.slice(0, PREVIEW_LIMIT));

      updateCharts({
        netEarning: netEarningResult, tips: tipsSum, expenses: totalExpenseSum,
        saving: remainingSaving, loan: remainingLoan,
        grabEarning: grabEarningSum, shopeeEarning: shopeeEarningSum, lalamoveEarning: lalamoveEarningSum, foodpandaEarning: foodpandaEarningSum,
        grabHours: grabHoursSum, shopeeHours: shopeeHoursSum, lalamoveHours: lalamoveHoursSum, foodpandaHours: foodpandaHoursSum
      });
    }

    // BARU: extract logik render supaya boleh dipakai untuk preview & modal penuh
    function buildHistoryHtml(logs) {
      if(!logs || logs.length === 0) {
        return `<div class="text-center py-6" style="color:var(--ink-soft)">No entries for this period.</div>`;
      }
      let html = "";
      logs.forEach(log => {
        const isDeposit = log.type === "Deposit";
        const badge = isDeposit
          ? `<span class="badge-deposit px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide">DEPOSIT</span>`
          : `<span class="badge-withdraw px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wide">WITHDRAW</span>`;
        const amtColor = isDeposit ? 'var(--sage-dark)' : 'var(--rose-dark)';
        const prefix = isDeposit ? '+ ' : '- ';
        html += `
          <div class="dashed-div pt-2">
            <div class="flex items-center justify-between mb-0.5">
              <span style="color:var(--ink-soft)">${log.date}</span>${badge}
            </div>
            <div class="dotted-row">
              <span class="font-bold">${log.category}</span>
              <span class="fill"></span>
              <span class="font-bold" style="color:${amtColor}">${prefix}RM ${Number(log.amount).toFixed(2)}</span>
            </div>
            <div class="text-[10px] truncate" style="color:var(--ink-soft)" title="${log.note}">${log.note}</div>
          </div>
        `;
      });
      return html;
    }

    // BARU: buka modal transaction log penuh
    function openHistoryModal() {
      const selectedMonth = document.getElementById('mainFilterMonth').value;
      const selectedYear = document.getElementById('mainFilterYear').value;
      const selectedPlatform = document.getElementById('mainFilterPlatform').value;
      const monthLabel = selectedMonth === "ALL" ? "All Months" : monthNames[parseInt(selectedMonth, 10)];
      const yearLabel = selectedYear === "ALL" ? "All Years" : selectedYear;
      const platformLabel = selectedPlatform === "ALL" ? "All Platforms" : selectedPlatform;

      document.getElementById('lblHistoryModalPeriod').innerText = monthLabel + " • " + yearLabel + " • " + platformLabel;
      document.getElementById('historyListFull').innerHTML = buildHistoryHtml(lastFilteredLogs);
      document.getElementById('modalHistory').classList.remove('hidden');
    }

    // BARU: tutup modal transaction log penuh
    function closeHistoryModal() {
      document.getElementById('modalHistory').classList.add('hidden');
    }

    function buildYearFilterDropdowns() {
      const mainYearSelect = document.getElementById('mainFilterYear');
      const savedYear = localStorage.getItem('riderhub_filterYear');
      const prevMainSelection = mainYearSelect.value !== 'ALL' ? mainYearSelect.value : savedYear;

      let existingYears = [];
      masterCachedHistoryLogs.forEach(log => {
        if (log.year && !existingYears.includes(log.year)) existingYears.push(log.year);
      });
      existingYears.sort((a, b) => a - b);
      let dropdownMarkup = '<option value="ALL">All Years</option>';
      existingYears.forEach(year => { dropdownMarkup += `<option value="${year}">${year}</option>`; });
      mainYearSelect.innerHTML = dropdownMarkup;
      if (existingYears.includes(parseInt(prevMainSelection))) mainYearSelect.value = prevMainSelection;
    }

    // BARU: tukar jam perpuluhan (cth 4.0833) kepada format "4h 5m" supaya tak mengelirukan
    function formatHoursToHM(decimalHours) {
      let totalMinutes = Math.round(decimalHours * 60);
      let h = Math.floor(totalMinutes / 60);
      let m = totalMinutes % 60;
      return h + "h " + m + "m";
    }

    function updateCharts(data) {
      const colors = { sage:'#9CAF88', sageLight:'#c9d6bd', rose:'#d9a5a0', slate:'#a7b4c4', slateLight:'#c6d0da', mustard:'#d9b26a' };
      const chartOptions = { responsive: true, maintainAspectRatio: true, plugins: { legend: { display:false } } };

      if(chartPlatformBar) chartPlatformBar.destroy();

      // BARU: bar chart Deposit (RM) & Working Hour setiap platform, guna dua axis (RM di kiri, Jam di kanan)
      var barCtx = document.getElementById('platformBarChart');
      if(barCtx) {
        chartPlatformBar = new Chart(barCtx.getContext('2d'), {
          type: 'bar',
          data: {
            labels: ['GrabFood', 'ShopeeFood', 'Lalamove', 'FoodPanda'],
            datasets: [
              {
                label: 'Deposit (RM)',
                data: [data.grabEarning, data.shopeeEarning, data.lalamoveEarning, data.foodpandaEarning],
                backgroundColor: colors.sage,
                yAxisID: 'y',
                borderRadius: 4
              },
              {
                label: 'Working Hour',
                data: [data.grabHours, data.shopeeHours, data.lalamoveHours, data.foodpandaHours],
                backgroundColor: colors.mustard,
                yAxisID: 'y1',
                borderRadius: 4
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: true, position: 'bottom', align: 'center',
                labels: { boxWidth: 6, font: { size: 8 }, padding: 6 }
              },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    if (ctx.dataset.label === 'Deposit (RM)') {
                      return 'Deposit: RM ' + Number(ctx.parsed.y).toFixed(2);
                    }
                    return 'Working Hour: ' + formatHoursToHM(ctx.parsed.y);
                  }
                }
              }
            },
            scales: {
              x: { ticks: { font: { size: 9 } }, grid: { display: false } },
              y: {
                type: 'linear', position: 'left', beginAtZero: true,
                title: { display: true, text: 'RM', font: { size: 8 } },
                ticks: { font: { size: 8 } }
              },
              y1: {
                type: 'linear', position: 'right', beginAtZero: true,
                title: { display: true, text: 'Hours', font: { size: 8 } },
                ticks: { font: { size: 8 } },
                grid: { drawOnChartArea: false }
              }
            }
          }
        });
      }
    }

    function openModal(type) {
      const modal = document.getElementById(type === 'add' ? 'modalAdd' : 'modalWithdraw');
      modal.classList.remove('hidden');
      if(type === 'add') {
        document.getElementById('addDate').valueAsDate = new Date();
        selectPlatformCard('GrabFood');
      } else {
        document.getElementById('withdrawDate').valueAsDate = new Date();
      }
    }

    function closeModal(type) {
      document.getElementById(type === 'add' ? 'modalAdd' : 'modalWithdraw').classList.add('hidden');
    }

    function selectPlatformCard(platform) {
      document.getElementById('selectedPlatform').value = platform;

      // BARU: peta setiap platform ke card & warna aktifnya supaya senang tambah platform baru
      const platformCardStyles = {
        GrabFood:   { el: document.getElementById('cardGrab'),     border: 'var(--sage)',    bg: 'var(--sage-bg)',    text: 'var(--sage-dark)' },
        ShopeeFood: { el: document.getElementById('cardShopee'),   border: 'var(--mustard)', bg: 'var(--mustard-bg)', text: '#a97e2f' },
        Lalamove:   { el: document.getElementById('cardLalamove'), border: 'var(--rose)',    bg: 'var(--rose-bg)',    text: 'var(--rose-dark)' },
        FoodPanda:  { el: document.getElementById('cardFoodPanda'), border: 'var(--panda)',   bg: 'var(--panda-bg)',   text: 'var(--panda-dark)' }
      };

      Object.keys(platformCardStyles).forEach(key => {
        const style = platformCardStyles[key];
        if (!style.el) return;
        if (key === platform) {
          style.el.style.borderColor = style.border;
          style.el.style.background = style.bg;
          style.el.querySelector('p').style.color = style.text;
        } else {
          style.el.style.borderColor = 'transparent';
          style.el.style.background = '#f4f0e6';
          style.el.querySelector('p').style.color = 'var(--ink-soft)';
        }
      });
    }

    function triggerConfirmation(type, event) {
      event.preventDefault();
      pendingActionType = type;
      const iconContainer = document.getElementById('confirmIconContainer');
      const icon = document.getElementById('confirmIcon');
      const submitBtn = document.getElementById('confirmSubmitBtn');
      const message = document.getElementById('confirmMessage');

      if (type === 'add') {
        pendingPayload = {
          date: document.getElementById('addDate').value,
          amount: document.getElementById('addAmount').value,
          tips: document.getElementById('addTips').value || 0,
          platform: document.getElementById('selectedPlatform').value,
          timeStart: document.getElementById('addTimeStart').value,
          timeEnd: document.getElementById('addTimeEnd').value
        };
        iconContainer.style.background = 'var(--sage-bg)'; iconContainer.style.color = 'var(--sage-dark)';
        icon.className = "fa-solid fa-cloud-arrow-up";
        submitBtn.style.background = 'var(--sage-dark)';
        message.innerText = `Add income entry of RM ${Number(pendingPayload.amount).toFixed(2)} (${pendingPayload.platform}) to your slip?`;
        submitBtn.onclick = executeAddFund;
      } else {
        pendingPayload = {
          date: document.getElementById('withdrawDate').value,
          amount: document.getElementById('withdrawAmount').value,
          category: document.querySelector('input[name="withdrawCat"]:checked').value,
          note: document.getElementById('withdrawNote').value
        };
        iconContainer.style.background = 'var(--rose-bg)'; iconContainer.style.color = 'var(--rose-dark)';
        icon.className = "fa-solid fa-wallet";
        submitBtn.style.background = 'var(--rose-dark)';
        message.innerText = `Record withdrawal of RM ${Number(pendingPayload.amount).toFixed(2)} under '${pendingPayload.category}'?`;
        submitBtn.onclick = executeWithdrawFund;
      }
      document.getElementById('confirmModal').classList.remove('hidden');
    }

    function closeConfirmation() { document.getElementById('confirmModal').classList.add('hidden'); pendingPayload = null; }

    // BARU: confirmation sebelum export & download PDF
    function confirmExportPdf() {
      const iconContainer = document.getElementById('confirmIconContainer');
      const icon = document.getElementById('confirmIcon');
      const submitBtn = document.getElementById('confirmSubmitBtn');
      const message = document.getElementById('confirmMessage');

      iconContainer.style.background = 'var(--slate-bg)'; iconContainer.style.color = 'var(--ink-soft)';
      icon.className = "fa-solid fa-file-pdf";
      submitBtn.style.background = 'var(--ink)';
      message.innerText = "Export current earnings slip as PDF and download to your device?";
      submitBtn.onclick = function () {
        document.getElementById('confirmModal').classList.add('hidden');
        generateAndDownloadPdf();
      };
      document.getElementById('confirmModal').classList.remove('hidden');
    }

    // BARU: bina & muat turun laporan PDF berdasarkan data & filter semasa
    function generateAndDownloadPdf() {
      try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ unit: 'pt', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        const marginX = 40;
        let y = 46;

        // HEADER: logo (ikon motosikal sebagai teks) + nama
        doc.setFont('courier', 'bold');
        doc.setFontSize(18);
        doc.text('RIDER HUB', pageWidth / 2, y, { align: 'center' });
        y += 16;

        doc.setFont('courier', 'normal');
        doc.setFontSize(9);
        doc.text('GrabFood x ShopeeFood x Lalamove x FoodPanda — Earnings Slip', pageWidth / 2, y, { align: 'center' });
        y += 12;
        doc.text('Generated: ' + document.getElementById('lblPrintedOn').innerText.trim(), pageWidth / 2, y, { align: 'center' });
        y += 18;

        doc.setDrawColor(200, 195, 178);
        doc.line(marginX, y, pageWidth - marginX, y);
        y += 22;

        // PERIOD FILTER
        const selectedMonthEl = document.getElementById('mainFilterMonth');
        const selectedYearEl = document.getElementById('mainFilterYear');
        const selectedPlatformEl = document.getElementById('mainFilterPlatform');
        const monthLabel = selectedMonthEl.value === 'ALL' ? 'All Months' : selectedMonthEl.options[selectedMonthEl.selectedIndex].text;
        const yearLabel = selectedYearEl.value === 'ALL' ? 'All Years' : selectedYearEl.value;
        const platformLabel = selectedPlatformEl.value === 'ALL' ? 'All Platforms' : selectedPlatformEl.value;

        doc.setFont('courier', 'bold');
        doc.setFontSize(10);
        doc.text('PERIOD: ' + monthLabel + '  •  ' + yearLabel + '  •  ' + platformLabel, marginX, y);
        y += 22;

        // EARNINGS SECTION
        doc.setFont('courier', 'bold');
        doc.setFontSize(10);
        doc.text('EARNINGS', marginX, y);
        y += 16;

        doc.setFont('courier', 'normal');
        doc.setFontSize(9);
        const earningsRows = [
          ['Net Earning', document.getElementById('lblNetEarning').innerText],
          ['Tip Received', document.getElementById('lblTips').innerText],
          ['Expense', document.getElementById('lblExpenses').innerText]
        ];
        earningsRows.forEach(row => {
          doc.text(row[0], marginX, y);
          doc.text(row[1], pageWidth - marginX, y, { align: 'right' });
          y += 15;
        });
        y += 8;

        // ALLOCATION REMAINING SECTION
        doc.setFont('courier', 'bold');
        doc.setFontSize(10);
        doc.text('ALLOCATION REMAINING', marginX, y);
        y += 16;

        doc.setFont('courier', 'normal');
        doc.setFontSize(9);
        const allocationRows = [
          ['Saving (30%)', document.getElementById('lblSaving').innerText],
          ['Loan (70%)', document.getElementById('lblLoan').innerText]
        ];
        allocationRows.forEach(row => {
          doc.text(row[0], marginX, y);
          doc.text(row[1], pageWidth - marginX, y, { align: 'right' });
          y += 15;
        });
        y += 8;

        // WORKING DAYS & HOURS
        doc.setFont('courier', 'bold');
        doc.setFontSize(10);
        doc.text('Working Days: ' + document.getElementById('lblWorkingDays').innerText, marginX, y);
        y += 14;
        doc.text('Working Hour: ' + document.getElementById('lblWorkingHour').innerText, marginX, y);
        y += 18;

        doc.setDrawColor(200, 195, 178);
        doc.line(marginX, y, pageWidth - marginX, y);
        y += 16;

        // FULL TRANSACTION LOG
        doc.setFont('courier', 'bold');
        doc.setFontSize(10);
        doc.text('FULL TRANSACTION LOG', marginX, y);
        y += 8;

        const tableBody = (lastFilteredLogs || []).map(log => [
          log.date,
          log.type,
          log.category,
          (log.type === 'Deposit' ? '+ ' : '- ') + 'RM ' + Number(log.amount).toFixed(2),
          log.note || '-'
        ]);

        doc.autoTable({
          startY: y + 8,
          head: [['Date', 'Type', 'Category', 'Amount', 'Note']],
          body: tableBody.length ? tableBody : [['-', '-', '-', '-', 'No entries for this period']],
          styles: { font: 'courier', fontSize: 8, cellPadding: 5, textColor: [74, 68, 56] },
          headStyles: { fillColor: [116, 136, 98], textColor: [255, 255, 255] },
          alternateRowStyles: { fillColor: [246, 242, 232] },
          margin: { left: marginX, right: marginX }
        });

        const safeMonth = monthLabel.replace(/\s+/g, '');
        const safeYear = String(yearLabel).replace(/\s+/g, '');
        doc.save(`RiderHub_Report_${safeMonth}_${safeYear}.pdf`);

        showToast("PDF report downloaded!", "success");
      } catch (e) {
        showToast("Failed to generate PDF: " + e.message, "error");
      }
    }

    function executeAddFund() {
      const submitBtn = document.getElementById('confirmSubmitBtn');
      submitBtn.disabled = true; submitBtn.innerText = "Saving...";
      apiPost("addFund", pendingPayload).then(function(data) {
        submitBtn.disabled = false; submitBtn.innerText = "Confirm"; closeConfirmation();
        const res = data.result;
        if(res === "Success") {
          document.getElementById('formAddFund').reset();
          closeModal('add');
          showToast("Funds recorded successfully!", "success");
          loadSheetTotals();
        } else { showToast(res, "error"); }
      }).catch(function(err) {
        submitBtn.disabled = false; submitBtn.innerText = "Confirm"; closeConfirmation();
        showToast("Failed: " + err, "error");
      });
    }

    function executeWithdrawFund() {
      const submitBtn = document.getElementById('confirmSubmitBtn');
      submitBtn.disabled = true; submitBtn.innerText = "Processing...";
      apiPost("withdrawFund", pendingPayload).then(function(data) {
        submitBtn.disabled = false; submitBtn.innerText = "Confirm"; closeConfirmation();
        const res = data.result;
        if(res === "Success") {
          document.getElementById('formWithdrawFund').reset();
          closeModal('withdraw');
          showToast("Withdrawal logged successfully!", "success");
          loadSheetTotals();
        } else { showToast(res, "error"); }
      }).catch(function(err) {
        submitBtn.disabled = false; submitBtn.innerText = "Confirm"; closeConfirmation();
        showToast("Failed: " + err, "error");
      });
    }

    function showToast(msg, type) {
      const toast = document.getElementById('toastNotification');
      const icon = document.getElementById('toastIcon');
      document.getElementById('toastMsg').innerText = msg;
      icon.className = type === 'success'
        ? "w-4 h-4 rounded-full flex items-center justify-center text-[9px] fa-solid fa-check"
        : "w-4 h-4 rounded-full flex items-center justify-center text-[9px] fa-solid fa-exclamation";
      icon.style.background = type === 'success' ? 'var(--sage)' : 'var(--rose)';
      icon.style.color = '#fff';
      toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
      toast.classList.add('opacity-100', 'translate-y-0');
      setTimeout(() => {
        toast.classList.remove('opacity-100', 'translate-y-0');
        toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
      }, 3200);
    }