let pendingPayload = null;
    let pendingActionType = '';
    let chartPlatformBar;
    let masterCachedHistoryLogs = [];
    let lastFilteredLogs = []; // BARU: simpan senarai terkini yang dah difilter, dipakai oleh modal "Lihat Semua"
    let monthlyAllocationRemaining = []; // BARU: breakdown Saving/Loan per bulan+tahun (FIFO) — HIDDEN, tak dipaparkan di UI buat masa ini

    // BARU: kira & papar duit dalam UNIT SEN (integer) sepenuhnya — elak terus isu floating-point
    // JS (cth 165.56000000000001) yang buat .toFixed() nampak macam "bundar". POTONG (truncate)
    // ke arah sifar, tiada bulatan langsung.
    function toCents_(num) {
      num = Number(num) || 0;
      var scaled = num * 100;
      // bersihkan 'noise' float pada aras sangat halus (1e-6) dahulu, supaya nilai sebenar
      // (cth 16555.999999999998 yang sepatutnya 16556) tak silap terpotong
      var cleaned = (scaled < 0 ? -1 : 1) * Math.round(Math.abs(scaled) * 1e6) / 1e6;
      return Math.trunc(cleaned); // integer sen, potong ke arah sifar — bukan bundar
    }
    function centsToStr_(cents) {
      var sign = cents < 0 ? '-' : '';
      cents = Math.abs(cents);
      var dollars = Math.floor(cents / 100);
      var rem = cents % 100;
      return sign + dollars + '.' + String(rem).padStart(2, '0');
    }
    function fmt2_(num) {
      return centsToStr_(toCents_(num));
    }

    // ================== API HELPER (GitHub Pages -> Google Apps Script Web App) ==================
    // API_URL ditakrifkan dalam index.html (sebelum <script src="script.js">)
    function apiGet(action) {
      // BARU: tambah parameter "_ts" unik + cache:"no-store" supaya browser/Google TAK pulangkan
      // response doGet yang di-cache lama.
      var cacheBuster = "&_ts=" + Date.now();
      return fetch(API_URL + "?action=" + encodeURIComponent(action) + cacheBuster, { cache: "no-store" })
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
      return apiGet("getDashboardData").then(function(res) {
        if(res.error) { showToast(res.error, "error"); return; }
        console.log("RIDERHUB_DEBUG history count:", (res.history || []).length);
        masterCachedHistoryLogs = res.history || [];
        buildYearFilterDropdowns();
        computeMonthlyAllocationRemaining_(); // BARU: bina breakdown Saving/Loan per bulan (FIFO) — hidden
        syncDashboardCalculations();
      }).catch(function(err) {
        showToast("Failed to load data: " + err, "error");
      });
    }

    // BARU: butang refresh — muat semula data terkini dari Sheet tanpa reload penuh page
    function refreshDashboard() {
      const btn = document.getElementById('btnRefresh');
      const icon = document.getElementById('refreshIcon');
      if (btn.disabled) return; // elak double-tap semasa masih loading
      btn.disabled = true;
      icon.classList.add('is-spinning');
      loadSheetTotals().then(function() {
        showToast("Dashboard refreshed!", "success");
      }).finally(function() {
        icon.classList.remove('is-spinning');
        btn.disabled = false;
      });
    }

    // BARU: Allocation Remaining PER BULAN+TAHUN (Saving 30% / Loan 70%) — HIDDEN, tak dipaparkan
    // di UI buat masa ini. Disimpan dalam `monthlyAllocationRemaining` untuk kegunaan akan datang.
    //
    // Cara ia berfungsi:
    // 1. Setiap bulan+tahun ada "baldi" (bucket) Saving & Loan sendiri, dikira 30%/70% daripada
    //    Net Earning bulan tersebut (selepas tolak Fuel & Lain-Lain, termasuk Tip/Incentive).
    // 2. Jumlah SEMUA withdrawal Saving (dan berasingan, Loan) — tak kira bulan withdrawal tu
    //    dibuat — dikumpul jadi satu "pool", kemudian ditolak secara FIFO (First-In-First-Out)
    //    bermula dari bucket bulan PALING LAMA dahulu. Contoh: bucket bulan 7 dihabiskan dulu;
    //    jika tak cukup, baki ditolak dari bucket bulan 8, kemudian bulan 9, dan seterusnya
    //    ikut turutan kronologi — tak kira bila (bulan mana) pengeluaran sebenar itu dibuat.
    // 3. Jika jumlah withdrawal melebihi jumlah SEMUA bucket (over-withdrawn), baki defisit
    //    diletakkan pada bucket bulan PALING BARU supaya jumlah keseluruhan kekal konsisten
    //    dengan Total Allocation Remaining (calculateAllocationRemainingAllTime_).
    function computeMonthlyAllocationRemaining_() {
      // Step 1: kumpul & jumlahkan data ikut key "tahun-bulan"
      let monthMap = {};
      masterCachedHistoryLogs.forEach(log => {
        let key = log.year * 100 + log.month;
        if (!monthMap[key]) {
          monthMap[key] = { year: log.year, month: log.month, netRaw: 0, tipsRaw: 0, fuelRaw: 0, lainRaw: 0 };
        }
        monthMap[key].netRaw += log.netEarningRaw;
        monthMap[key].tipsRaw += log.tipsRaw;
        monthMap[key].fuelRaw += log.fuelRaw;
        monthMap[key].lainRaw += log.lainRaw || 0;
      });

      // Step 2: susun kronologi menaik (paling lama dahulu) — turutan ini yang jadi asas FIFO
      let months = Object.keys(monthMap).map(k => monthMap[k]).sort(function(a, b) {
        return (a.year * 10000 + a.month) - (b.year * 10000 + b.month);
      });

      // Step 3: kira jumlah "generated" Saving (30%) & Loan (70%) setiap bucket bulan, dalam SEN
      months.forEach(m => {
        let netAfterFuelLain = (m.netRaw + m.tipsRaw) - m.fuelRaw - m.lainRaw;
        m.savingGeneratedCents = toCents_(netAfterFuelLain * 0.30);
        m.loanGeneratedCents = toCents_(netAfterFuelLain) - m.savingGeneratedCents; // baki tepat, elak isu float
      });

      // Step 4: jumlah keseluruhan withdrawal Saving & Loan (SEMUA masa, tak kira bulan withdrawal dibuat)
      let savingPoolCents = 0, loanPoolCents = 0;
      masterCachedHistoryLogs.forEach(log => {
        savingPoolCents += toCents_(log.savingRaw);
        loanPoolCents += toCents_(log.loanRaw);
      });

      // Step 5: telan pool FIFO dari bucket paling lama ke paling baru
      months.forEach(m => {
        let usedSaving = Math.min(m.savingGeneratedCents, savingPoolCents);
        m.savingRemainingCents = m.savingGeneratedCents - usedSaving;
        savingPoolCents -= usedSaving;

        let usedLoan = Math.min(m.loanGeneratedCents, loanPoolCents);
        m.loanRemainingCents = m.loanGeneratedCents - usedLoan;
        loanPoolCents -= usedLoan;
      });

      // Step 6: jika pool masih berbaki selepas semua bucket ditelan (over-withdrawn),
      // letak defisit pada bucket bulan PALING BARU (supaya jumlah keseluruhan tetap padan)
      if (months.length > 0 && (savingPoolCents > 0 || loanPoolCents > 0)) {
        let latest = months[months.length - 1];
        latest.savingRemainingCents -= savingPoolCents;
        latest.loanRemainingCents -= loanPoolCents;
      }

      // Step 7: hasil akhir — nilai dalam ringgit (bukan sen), sedia untuk dipaparkan kelak
      monthlyAllocationRemaining = months.map(m => ({
        year: m.year,
        month: m.month,
        savingGenerated: m.savingGeneratedCents / 100,
        loanGenerated: m.loanGeneratedCents / 100,
        savingRemaining: m.savingRemainingCents / 100,
        loanRemaining: m.loanRemainingCents / 100
      }));

      // BARU: debug sementara — buka console untuk lihat breakdown per bulan (data ini hidden dari UI)
      console.log("RIDERHUB_DEBUG monthlyAllocationRemaining:", monthlyAllocationRemaining);
    }

    // BARU: Allocation Remaining (Saving 30% / Loan 70%) SENTIASA dikira dari SEMUA data
    // (semua bulan, semua tahun, semua platform) — TIDAK terjejas oleh filter Month/Year/Platform
    // pada dashboard. Fungsi ini sengaja tidak baca selectedMonth/selectedYear/selectedPlatform.
    function calculateAllocationRemainingAllTime_() {
      let rawNetEarningSum = 0, tipsSum = 0, fuelSum = 0, lainSum = 0;
      let savingExpenseSum = 0, loanExpenseSum = 0;

      masterCachedHistoryLogs.forEach(log => {
        rawNetEarningSum += log.netEarningRaw;
        tipsSum += log.tipsRaw;
        fuelSum += log.fuelRaw;
        lainSum += log.lainRaw || 0;
        savingExpenseSum += log.savingRaw;
        loanExpenseSum += log.loanRaw;
      });

      // Net Earning termasuk Tip Received/Incentive sekali (sama macam paparan ALL platform)
      rawNetEarningSum += tipsSum;

      let netEarningAfterFuelLain = rawNetEarningSum - fuelSum - lainSum;
      let remainingSaving = (netEarningAfterFuelLain * 0.30) - savingExpenseSum;

      // Kira integer SEN supaya Saving + Loan sentiasa jumlah tepat sama dengan (Net Earning - Expense)
      let netEarningResultCents_ = toCents_(netEarningAfterFuelLain - savingExpenseSum - loanExpenseSum);
      let savingCents_ = toCents_(remainingSaving);
      let loanCents_ = netEarningResultCents_ - savingCents_;

      return {
        saving: savingCents_ / 100,
        loan: loanCents_ / 100
      };
    }

    function syncDashboardCalculations() {
      const selectedMonth = document.getElementById('mainFilterMonth').value;
      const selectedYear = document.getElementById('mainFilterYear').value;
      const selectedPlatform = document.getElementById('mainFilterPlatform').value;
      console.log("RIDERHUB_DEBUG filters:", JSON.stringify({ selectedMonth, selectedYear, selectedPlatform })); // BARU: debug sementara

      // Step 1: tapis ikut month/year sahaja dulu — platform dikendali berasingan ikut jenis kad di bawah
      let periodLogs = masterCachedHistoryLogs.filter(log => {
        if (selectedMonth !== "ALL" && String(log.month) !== selectedMonth) return false;
        if (selectedYear !== "ALL" && String(log.year) !== selectedYear) return false;
        return true;
      });
      console.log("RIDERHUB_DEBUG periodLogs count:", periodLogs.length); // BARU: debug sementara

      let uniqueWorkingDates = {};
      let filteredLogs;
      let tipsSum = 0, fuelSum = 0, lainSum = 0;
      let grabEarningSum = 0, shopeeEarningSum = 0, foodpandaEarningSum = 0;
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

          if (log.type === "Deposit") {
            if (log.category === "GrabFood") { grabEarningSum += log.netEarningRaw; }
            else if (log.category === "ShopeeFood") { shopeeEarningSum += log.netEarningRaw; }
            else if (log.category === "FoodPanda") { foodpandaEarningSum += log.netEarningRaw; }
          }
        });

        // BARU: Net Earning kini termasuk Tip Received sekali
        rawNetEarningSum += tipsSum;

        totalExpenseSum = fuelSum + savingExpenseSum + loanExpenseSum + lainSum;
        netEarningResult = rawNetEarningSum - totalExpenseSum;

        // NOTA: Saving/Loan TIDAK lagi dikira di sini ikut period yang difilter — kini
        // sentiasa diambil dari calculateAllocationRemainingAllTime_() (semua bulan/tahun/platform).
        let netEarningCents_ = toCents_(netEarningResult);
        netEarningResult = netEarningCents_ / 100;

      } else {
        // ---- PAPARAN IKUT PLATFORM (GrabFood / ShopeeFood / FoodPanda) ----
        showBlankExpenseAllocation = true;

        periodLogs.forEach(log => {
          if (log.type === "Deposit" && log.category === selectedPlatform) {
            netEarningResult += log.netEarningRaw;
            tipsSum += log.tipsRaw;
            uniqueWorkingDates[log.date] = true;
            if (log.category === "GrabFood") { grabEarningSum += log.netEarningRaw; }
            else if (log.category === "ShopeeFood") { shopeeEarningSum += log.netEarningRaw; }
            else if (log.category === "FoodPanda") { foodpandaEarningSum += log.netEarningRaw; }
          }
        });

        // Transaction log ikut platform: deposit platform terpilih sahaja
        filteredLogs = periodLogs.filter(log => log.type === "Deposit" && log.category === selectedPlatform);

        // BARU: Net Earning kini termasuk Tip Received sekali (sama macam paparan ALL)
        netEarningResult += tipsSum;

      }

      lastFilteredLogs = filteredLogs; // BARU: simpan untuk dipakai oleh modal "Lihat Semua"

      // BARU: Allocation Remaining (Saving/Loan) sentiasa dikira dari SEMUA data (all month/year/platform)
      // — tidak terjejas oleh filter di atas, walaupun Month/Year/Platform ditukar.
      const allocationAllTime = calculateAllocationRemainingAllTime_();
      remainingSaving = allocationAllTime.saving;
      remainingLoan = allocationAllTime.loan;

      document.getElementById('lblWorkingDays').innerText = Object.keys(uniqueWorkingDates).length + " Days";

      document.getElementById('lblNetEarning').innerText = "RM " + fmt2_(netEarningResult);
      document.getElementById('lblTips').innerText = "RM " + fmt2_(tipsSum);
      document.getElementById('lblExpenses').innerText = showBlankExpenseAllocation ? "-" : ("RM " + fmt2_(totalExpenseSum));
      document.getElementById('lblSaving').innerText = "RM " + fmt2_(remainingSaving);
      document.getElementById('lblLoan').innerText = "RM " + fmt2_(remainingLoan);

      // BARU: preview terhad di resit utama
      document.getElementById('historyList').innerHTML = buildHistoryHtml(filteredLogs.slice(0, PREVIEW_LIMIT));

      updateCharts({
        netEarning: netEarningResult, tips: tipsSum, expenses: totalExpenseSum,
        saving: remainingSaving, loan: remainingLoan,
        grabEarning: grabEarningSum, shopeeEarning: shopeeEarningSum, foodpandaEarning: foodpandaEarningSum
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

        // BARU: kalau deposit ni ada Tip Received dan/atau Incentive, papar breakdown kecil sekali
        let tipBreakdownHtml = "";
        if (isDeposit && ((log.tipReceivedRaw || 0) > 0 || (log.incentiveRaw || 0) > 0)) {
          let parts = "";
          if ((log.tipReceivedRaw || 0) > 0) {
            parts += `<div class="dotted-row text-[10px]" style="color:var(--sage-dark)">
              <span>Tip Received</span><span class="fill"></span><span>+ RM ${Number(log.tipReceivedRaw).toFixed(2)}</span>
            </div>`;
          }
          if ((log.incentiveRaw || 0) > 0) {
            parts += `<div class="dotted-row text-[10px]" style="color:var(--sage-dark)">
              <span>Incentive</span><span class="fill"></span><span>+ RM ${Number(log.incentiveRaw).toFixed(2)}</span>
            </div>`;
          }
          tipBreakdownHtml = `<div class="space-y-0.5 mt-0.5">${parts}</div>`;
        }

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
            ${tipBreakdownHtml}
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

    function updateCharts(data) {
      const colors = { sage:'#9CAF88', sageLight:'#c9d6bd', rose:'#d9a5a0', slate:'#a7b4c4', slateLight:'#c6d0da', mustard:'#d9b26a' };

      if(chartPlatformBar) chartPlatformBar.destroy();

      // Bar chart Deposit (RM) setiap platform
      var barCtx = document.getElementById('platformBarChart');
      if(barCtx) {
        chartPlatformBar = new Chart(barCtx.getContext('2d'), {
          type: 'bar',
          data: {
            labels: ['GrabFood', 'ShopeeFood', 'FoodPanda'],
            datasets: [
              {
                label: 'Deposit (RM)',
                data: [data.grabEarning, data.shopeeEarning, data.foodpandaEarning],
                backgroundColor: colors.sage,
                borderRadius: 4
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: function(ctx) {
                    return 'Deposit: RM ' + Number(ctx.parsed.y).toFixed(2);
                  }
                }
              }
            },
            scales: {
              x: { ticks: { font: { size: 9 } }, grid: { display: false } },
              y: {
                beginAtZero: true,
                title: { display: true, text: 'RM', font: { size: 8 } },
                ticks: { font: { size: 8 } }
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
          tipType: document.querySelector('input[name="addTipType"]:checked').value,
          platform: document.getElementById('selectedPlatform').value
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
        doc.text('GrabFood x ShopeeFood x FoodPanda — Earnings Slip', pageWidth / 2, y, { align: 'center' });
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
          ['Tip Received/Incentive', document.getElementById('lblTips').innerText],
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

        // WORKING DAYS
        doc.setFont('courier', 'bold');
        doc.setFontSize(10);
        doc.text('Working Days: ' + document.getElementById('lblWorkingDays').innerText, marginX, y);
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
