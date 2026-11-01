(function(){

  /* =========================================================
     状态
     ========================================================= */

  let workbook = null;
  let currentSheetName = "";
  let originalFileName = "新工作簿.xlsx";

  let renderedRows = 50;
  let renderedCols = 20;

  let activeCell = {
    r: 0,
    c: 0
  };

  let selection = {
    r1: 0,
    c1: 0,
    r2: 0,
    c2: 0
  };

  let undoStack = [];
  let redoStack = [];
  const MAX_HISTORY = 30;


  /* =========================================================
     DOM
     ========================================================= */

  const fileInput = document.getElementById("xlsx_fileInput");
  const selectFileBtn = document.getElementById("xlsx_selectFileBtn");
  const newWorkbookBtn = document.getElementById("xlsx_newWorkbookBtn");
  const exportBtn = document.getElementById("xlsx_exportBtn");
  const fileNameSpan = document.getElementById("xlsx_fileName");

  const sheetTable = document.getElementById("xlsx_sheetTable");
  const sheetTabs = document.getElementById("xlsx_sheetTabs");

  const formulaInput = document.getElementById("xlsx_formulaInput");
  const nameBox = document.getElementById("xlsx_nameBox");

  const fontNameSelect = document.getElementById("xlsx_fontNameSelect");
  const fontSizeSelect = document.getElementById("xlsx_fontSizeSelect");
  const fontColorPicker = document.getElementById("xlsx_fontColorPicker");
  const fillColorPicker = document.getElementById("xlsx_fillColorPicker");
  const numberFormatSelect = document.getElementById("xlsx_numberFormatSelect");

  const boldBtn = document.getElementById("xlsx_boldBtn");
  const italicBtn = document.getElementById("xlsx_italicBtn");
  const underlineBtn = document.getElementById("xlsx_underlineBtn");

  const borderBtn = document.getElementById("xlsx_borderBtn");
  const clearFormatBtn = document.getElementById("xlsx_clearFormatBtn");
  const mergeBtn = document.getElementById("xlsx_mergeBtn");
  const unmergeBtn = document.getElementById("xlsx_unmergeBtn");

  const addSheetBtn = document.getElementById("xlsx_addSheetBtn");
  const renameSheetBtn = document.getElementById("xlsx_renameSheetBtn");
  const deleteSheetBtn = document.getElementById("xlsx_deleteSheetBtn");

  const addRowsBtn = document.getElementById("xlsx_addRowsBtn");
  const addColsBtn = document.getElementById("xlsx_addColsBtn");

  const undoBtn = document.getElementById("xlsx_undoBtn");
  const redoBtn = document.getElementById("xlsx_redoBtn");

  const statusSpan = document.getElementById("xlsx_status");
  const cellStatus = document.getElementById("xlsx_cellStatus");
  const selectionStatus = document.getElementById("xlsx_selectionStatus");


  /* =========================================================
     初始化
     ========================================================= */

  async function init() {
    // xlsx 由 almostnode 运行时内置提供（不再依赖 xlsx.bundle.js）：等待引导脚本把库注入 window。
    // 注意：不能用 typeof XLSX === "undefined" 判断——xlsx 的 UMD bundle 可能在 window 上留下
    // 一个没有 read/utils 的空壳对象，必须校验真正的 API 是否存在，否则会误判为“已就绪”。
    function xlsxReady() {
      return typeof XLSX !== "undefined" && !!XLSX && typeof XLSX.read === "function";
    }
    if (!xlsxReady() && window.__waitOfficeLibs) {
      try { await window.__waitOfficeLibs(30000); } catch (_) {}
    }
    if (!xlsxReady()) {
      alert("XLSX 库加载失败：almostnode 运行时未提供 xlsx。");
      return;
    }

    createBlankWorkbook(false);

    selectFileBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", handleFileSelect);

    newWorkbookBtn.addEventListener("click", () => {
      if (!confirm("确定创建新工作簿吗？当前未导出的修改将丢失。")) {
        return;
      }

      createBlankWorkbook();
    });

    exportBtn.addEventListener("click", exportWorkbook);

    formulaInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        setActiveCellFromFormula();
      }
    });

    formulaInput.addEventListener("blur", () => {
      setActiveCellFromFormula();
    });


    /* 字体 */

    fontNameSelect.addEventListener("change", () => {
      applyStyle(style => {
        style.font = style.font || {};
        style.font.name = fontNameSelect.value;
      });
    });

    fontSizeSelect.addEventListener("change", () => {
      applyStyle(style => {
        style.font = style.font || {};
        style.font.sz = Number(fontSizeSelect.value);
      });
    });


    /* 粗体 */

    boldBtn.addEventListener("click", () => {
      const cell = getActiveCellObject();
      const current = !!cell?.s?.font?.bold;

      applyStyle(style => {
        style.font = style.font || {};
        style.font.bold = !current;
      });
    });


    /* 斜体 */

    italicBtn.addEventListener("click", () => {
      const cell = getActiveCellObject();
      const current = !!cell?.s?.font?.italic;

      applyStyle(style => {
        style.font = style.font || {};
        style.font.italic = !current;
      });
    });


    /* 下划线 */

    underlineBtn.addEventListener("click", () => {
      const cell = getActiveCellObject();
      const current = !!cell?.s?.font?.underline;

      applyStyle(style => {
        style.font = style.font || {};
        style.font.underline = !current;
      });
    });


    /* 字色 */

    fontColorPicker.addEventListener("input", () => {
      applyStyle(style => {
        style.font = style.font || {};
        style.font.color = {
          rgb: colorToARGB(fontColorPicker.value)
        };
      }, false);
    });

    fontColorPicker.addEventListener("change", () => {
      renderSheet();
    });


    /* 背景色 */

    fillColorPicker.addEventListener("input", () => {
      applyStyle(style => {
        style.fill = {
          patternType: "solid",
          fgColor: {
            rgb: colorToARGB(fillColorPicker.value)
          },
          bgColor: {
            rgb: colorToARGB(fillColorPicker.value)
          }
        };
      }, false);
    });

    fillColorPicker.addEventListener("change", () => {
      renderSheet();
    });


    /* 水平对齐 */

    document.querySelectorAll("[data-align]").forEach(button => {
      button.addEventListener("click", () => {
        applyStyle(style => {
          style.alignment = style.alignment || {};
          style.alignment.horizontal = button.dataset.align;
        });
      });
    });


    /* 垂直对齐 */

    document.querySelectorAll("[data-valign]").forEach(button => {
      button.addEventListener("click", () => {
        applyStyle(style => {
          style.alignment = style.alignment || {};
          style.alignment.vertical = button.dataset.valign;
        });
      });
    });


    /* 数字格式 */

    numberFormatSelect.addEventListener("change", () => {
      pushHistory();

      forEachSelectedCell((cell) => {
        cell.z = numberFormatSelect.value;

        cell.s = cell.s || {};
        cell.s.numFmt = numberFormatSelect.value;
      });

      redoStack = [];
      renderSheet();

      setStatus("已设置数字格式");
    });


    borderBtn.addEventListener("click", applyAllBorders);
    clearFormatBtn.addEventListener("click", clearCellFormatting);

    mergeBtn.addEventListener("click", mergeSelectedCells);
    unmergeBtn.addEventListener("click", unmergeSelectedCells);

    addSheetBtn.addEventListener("click", addSheet);
    renameSheetBtn.addEventListener("click", renameCurrentSheet);
    deleteSheetBtn.addEventListener("click", deleteCurrentSheet);

    addRowsBtn.addEventListener("click", () => {
      renderedRows += 10;
      renderSheet();
    });

    addColsBtn.addEventListener("click", () => {
      renderedCols += 5;
      renderSheet();
    });

    undoBtn.addEventListener("click", undo);
    redoBtn.addEventListener("click", redo);


    /* Ctrl + Z / Ctrl + Y */

    document.addEventListener("keydown", event => {
      if (!xlsxEditorIsActive()) return;
      const isCtrl = event.ctrlKey || event.metaKey;

      if (!isCtrl) return;

      if (
        event.key.toLowerCase() === "z" &&
        !event.shiftKey
      ) {
        event.preventDefault();
        undo();
      }

      if (
        event.key.toLowerCase() === "y" ||
        (
          event.key.toLowerCase() === "z" &&
          event.shiftKey
        )
      ) {
        event.preventDefault();
        redo();
      }
    });
  }


  /* =========================================================
     创建空工作簿
     ========================================================= */

  function createBlankWorkbook(resetName = true) {
    workbook = XLSX.utils.book_new();

    const ws = XLSX.utils.aoa_to_sheet([
      ["", "", "", "", ""],
      ["", "", "", "", ""],
      ["", "", "", "", ""]
    ]);

    XLSX.utils.book_append_sheet(
      workbook,
      ws,
      "Sheet1"
    );

    currentSheetName = "Sheet1";

    if (resetName) {
      originalFileName = "新工作簿.xlsx";
      fileNameSpan.textContent = "";
    }

    renderedRows = 50;
    renderedCols = 20;

    activeCell = {
      r: 0,
      c: 0
    };

    selection = {
      r1: 0,
      c1: 0,
      r2: 0,
      c2: 0
    };

    undoStack = [];
    redoStack = [];

    renderAll();
    setStatus("新工作簿已就绪");
  }


  /* =========================================================
     文件读取
     ========================================================= */

  function handleFileSelect(event) {
    const file = event.target.files[0];

    if (!file) return;

    const extension = file.name
      .split(".")
      .pop()
      .toLowerCase();

    if (!["xlsx", "xls", "xlsm", "xlsb"].includes(extension)) {
      alert("请选择有效的 Excel 文件。");
      return;
    }

    fileNameSpan.textContent = file.name;

    originalFileName =
      file.name.replace(/\.[^.]+$/i, "") +
      "_编辑版.xlsx";

    setStatus("正在读取工作簿...");

    const reader = new FileReader();

    reader.onload = function(e) {
      try {
        workbook = XLSX.read(
          e.target.result,
          {
            type: "array",

            /* 保留基本样式 */
            cellStyles: true,

            /* 保留公式 */
            cellFormula: true,

            /* 保留数字格式 */
            cellNF: true,

            /* 保留富文本对应值 */
            cellHTML: true,

            /* 日期作为 Date */
            cellDates: true
          }
        );

        if (
          !workbook ||
          !workbook.SheetNames ||
          workbook.SheetNames.length === 0
        ) {
          throw new Error("工作簿中没有工作表");
        }

        currentSheetName = workbook.SheetNames[0];

        calculateRenderSize();

        activeCell = {
          r: 0,
          c: 0
        };

        selection = {
          r1: 0,
          c1: 0,
          r2: 0,
          c2: 0
        };

        undoStack = [];
        redoStack = [];

        renderAll();

        setStatus("工作簿已就绪，可开始编辑");
      } catch (error) {
        console.error(error);

        alert(
          "无法读取 Excel 文件：" +
          error.message
        );

        setStatus("文件读取失败");
      }
    };

    reader.onerror = function() {
      alert("文件读取失败。");
      setStatus("文件读取失败");
    };

    reader.readAsArrayBuffer(file);

    fileInput.value = "";
  }


  /* =========================================================
     根据当前 Sheet 自动决定显示大小
     ========================================================= */

  function calculateRenderSize() {
    const ws = getCurrentSheet();

    let rows = 50;
    let cols = 20;

    if (ws && ws["!ref"]) {
      try {
        const range =
          XLSX.utils.decode_range(ws["!ref"]);

        rows = Math.max(
          50,
          range.e.r + 10
        );

        cols = Math.max(
          20,
          range.e.c + 5
        );
      } catch (e) {
        console.warn(e);
      }
    }

    /*
      防止超大 Excel 一次生成几十万个 DOM，
      这里先限制初始显示区域。
      用户仍然可以点 +10 行、+5 列继续扩展。
    */

    renderedRows = Math.min(rows, 300);
    renderedCols = Math.min(cols, 80);
  }


  /* =========================================================
     获取当前 Sheet
     ========================================================= */

  function getCurrentSheet() {
    return workbook?.Sheets?.[currentSheetName] || null;
  }


  /* =========================================================
     渲染
     ========================================================= */

  function renderAll() {
    renderSheetTabs();
    renderSheet();
    updateFormulaBar();
  }


  function renderSheetTabs() {
    sheetTabs.innerHTML = "";

    workbook.SheetNames.forEach(name => {
      const button =
        document.createElement("button");

      button.className = "sheet-tab";

      if (name === currentSheetName) {
        button.classList.add("active");
      }

      button.textContent = name;

      button.addEventListener("click", () => {
        currentSheetName = name;

        activeCell = {
          r: 0,
          c: 0
        };

        selection = {
          r1: 0,
          c1: 0,
          r2: 0,
          c2: 0
        };

        calculateRenderSize();
        renderAll();

        setStatus(
          `已切换到工作表：${name}`
        );
      });

      sheetTabs.appendChild(button);
    });
  }


  function renderSheet() {
    const ws = getCurrentSheet();

    if (!ws) return;

    sheetTable.innerHTML = "";

    /*
      表头
    */

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    const corner = document.createElement("th");
    corner.className = "corner";

    headerRow.appendChild(corner);

    for (
      let c = 0;
      c < renderedCols;
      c++
    ) {
      const th = document.createElement("th");

      th.className = "column-header";
      th.textContent = XLSX.utils.encode_col(c);

      /*
        点击列号选择整列的当前显示区域
      */

      th.addEventListener("click", () => {
        activeCell = {
          r: 0,
          c
        };

        selection = {
          r1: 0,
          c1: c,
          r2: renderedRows - 1,
          c2: c
        };

        updateSelectionUI();
        updateFormulaBar();
      });

      headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);
    sheetTable.appendChild(thead);


    /*
      主体
    */

    const tbody = document.createElement("tbody");

    for (
      let r = 0;
      r < renderedRows;
      r++
    ) {
      const tr = document.createElement("tr");

      const rowHeader =
        document.createElement("th");

      rowHeader.className = "row-header";
      rowHeader.textContent = r + 1;

      rowHeader.addEventListener("click", () => {
        activeCell = {
          r,
          c: 0
        };

        selection = {
          r1: r,
          c1: 0,
          r2: r,
          c2: renderedCols - 1
        };

        updateSelectionUI();
        updateFormulaBar();
      });

      tr.appendChild(rowHeader);


      for (
        let c = 0;
        c < renderedCols;
        c++
      ) {
        const td =
          createCellElement(r, c, ws);

        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    sheetTable.appendChild(tbody);

    applyMergeRendering(ws);
    updateSelectionUI();
  }


  /* =========================================================
     创建单元格 DOM
     ========================================================= */

  function createCellElement(r, c, ws) {
    const td = document.createElement("td");

    td.className = "sheet-cell";
    td.contentEditable = "true";

    td.dataset.row = r;
    td.dataset.col = c;

    const address =
      XLSX.utils.encode_cell({
        r,
        c
      });

    const cell = ws[address];

    if (cell) {
      td.textContent =
        getCellDisplayValue(cell);

      if (cell.f) {
        td.classList.add("formula-cell");
        td.title = "=" + cell.f;
      }

      applyCellStyleToElement(
        td,
        cell.s
      );
    }


    /* ======================
       单元格选择
       ====================== */

    td.addEventListener("mousedown", event => {
      const row =
        Number(td.dataset.row);

      const col =
        Number(td.dataset.col);

      if (event.shiftKey) {
        selection.r2 = row;
        selection.c2 = col;
      } else {
        activeCell = {
          r: row,
          c: col
        };

        selection = {
          r1: row,
          c1: col,
          r2: row,
          c2: col
        };
      }

      normalizeSelection();

      updateSelectionUI();
      updateFormulaBar();
    });


    /* ======================
       编辑开始
       ====================== */

    td.addEventListener("focus", () => {
      const r = Number(td.dataset.row);
      const c = Number(td.dataset.col);

      /*
        如果不是当前选择区域中的单元格，
        自动设为活动单元格。
      */

      if (!isInSelection(r, c)) {
        activeCell = { r, c };

        selection = {
          r1: r,
          c1: c,
          r2: r,
          c2: c
        };

        updateSelectionUI();
      }

      updateFormulaBar();
    });


    /* ======================
       单元格修改
       ====================== */

    td.addEventListener("blur", () => {
      commitCell(td);
    });


    td.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();

        commitCell(td);

        moveActiveCell(1, 0);
      }

      if (event.key === "Tab") {
        event.preventDefault();

        commitCell(td);

        moveActiveCell(
          0,
          event.shiftKey ? -1 : 1
        );
      }
    });


    /* ======================
       多单元格粘贴
       ====================== */

    td.addEventListener("paste", event => {
      handleCellPaste(event, r, c);
    });

    return td;
  }


  /* =========================================================
     单元格显示值
     ========================================================= */

  function getCellDisplayValue(cell) {
    if (!cell) return "";

    /*
      SheetJS 读取时通常会生成格式化后的 w。
      优先使用 w 可以让日期/百分比显示接近 Excel。
    */

    if (cell.w !== undefined) {
      return String(cell.w);
    }

    if (cell.v === undefined || cell.v === null) {
      /*
        只有公式但没有缓存计算值
      */

      if (cell.f) {
        return "=" + cell.f;
      }

      return "";
    }

    if (cell.v instanceof Date) {
      return formatDate(cell.v);
    }

    return String(cell.v);
  }


  /* =========================================================
     编辑单元格
     ========================================================= */

  function commitCell(td) {
    if (!workbook) return;

    const r = Number(td.dataset.row);
    const c = Number(td.dataset.col);

    const address =
      XLSX.utils.encode_cell({
        r,
        c
      });

    const ws = getCurrentSheet();

    const text =
      td.innerText
        .replace(/\r/g, "")
        .trimEnd();

    const oldCell = ws[address];

    const oldValue = oldCell?.f
      ? "=" + oldCell.f
      : oldCell?.v ?? "";

    if (
      String(oldValue) === text
    ) {
      return;
    }

    pushHistory();

    setCellValue(
      ws,
      r,
      c,
      text,
      true
    );

    updateSheetRef(ws);

    redoStack = [];

    updateFormulaBar();

    setStatus(
      `已修改 ${address}`
    );
  }


  /* =========================================================
     将输入转换成 XLSX Cell
     ========================================================= */

  function setCellValue(
    ws,
    r,
    c,
    value,
    preserveStyle = true
  ) {
    const address =
      XLSX.utils.encode_cell({
        r,
        c
      });

    const old =
      ws[address] || {};

    const style =
      preserveStyle
        ? clone(old.s || {})
        : {};

    const numberFormat = old.z;

    /*
      空内容
    */

    if (value === "") {
      /*
        不直接删除，因为可能存在样式。
      */

      ws[address] = {
        t: "s",
        v: "",
        s: style
      };

      if (numberFormat) {
        ws[address].z = numberFormat;
      }

      return;
    }


    /*
      公式
    */

    if (
      typeof value === "string" &&
      value.startsWith("=")
    ) {
      ws[address] = {
        t: "n",
        f: value.substring(1),
        s: style
      };

      if (numberFormat) {
        ws[address].z = numberFormat;
      }

      return;
    }


    /*
      Boolean
    */

    if (
      String(value).toUpperCase() === "TRUE"
    ) {
      ws[address] = {
        t: "b",
        v: true,
        s: style
      };

      return;
    }

    if (
      String(value).toUpperCase() === "FALSE"
    ) {
      ws[address] = {
        t: "b",
        v: false,
        s: style
      };

      return;
    }


    /*
      数字

      防止：
      00123
      被自动变成 123
    */

    const valueString = String(value);

    const looksLikeLeadingZero =
      /^0\d+/.test(valueString);

    if (
      !looksLikeLeadingZero &&
      valueString.trim() !== "" &&
      Number.isFinite(Number(valueString))
    ) {
      ws[address] = {
        t: "n",
        v: Number(valueString),
        s: style
      };

      if (numberFormat) {
        ws[address].z = numberFormat;
      }

      return;
    }


    /*
      普通字符串
    */

    ws[address] = {
      t: "s",
      v: valueString,
      s: style
    };

    if (numberFormat) {
      ws[address].z = numberFormat;
    }
  }


  /* =========================================================
     公式栏
     ========================================================= */

  function updateFormulaBar() {
    const address =
      XLSX.utils.encode_cell(activeCell);

    nameBox.value = address;

    const cell =
      getCurrentSheet()?.[address];

    if (!cell) {
      formulaInput.value = "";
    } else if (cell.f) {
      formulaInput.value =
        "=" + cell.f;
    } else {
      formulaInput.value =
        cell.v ?? "";
    }

    cellStatus.textContent =
      `当前单元格: ${address}`;

    selectionStatus.textContent =
      `选择范围: ${getSelectionAddress()}`;

    updateToolbarFromCell();
  }


  function setActiveCellFromFormula() {
    const ws = getCurrentSheet();

    if (!ws) return;

    const value =
      formulaInput.value;

    const address =
      XLSX.utils.encode_cell(activeCell);

    const current = ws[address];

    const currentValue =
      current?.f
        ? "=" + current.f
        : current?.v ?? "";

    if (
      String(currentValue) ===
      String(value)
    ) {
      return;
    }

    pushHistory();

    setCellValue(
      ws,
      activeCell.r,
      activeCell.c,
      value,
      true
    );

    updateSheetRef(ws);

    redoStack = [];

    renderSheet();

    setStatus(
      `已修改 ${address}`
    );
  }


  /* =========================================================
     移动活动单元格
     ========================================================= */

  function moveActiveCell(rowDelta, colDelta) {
    activeCell.r = Math.max(
      0,
      Math.min(
        renderedRows - 1,
        activeCell.r + rowDelta
      )
    );

    activeCell.c = Math.max(
      0,
      Math.min(
        renderedCols - 1,
        activeCell.c + colDelta
      )
    );

    selection = {
      r1: activeCell.r,
      c1: activeCell.c,
      r2: activeCell.r,
      c2: activeCell.c
    };

    updateSelectionUI();
    updateFormulaBar();

    const element =
      getCellElement(
        activeCell.r,
        activeCell.c
      );

    element?.focus();
  }


  /* =========================================================
     选择区域
     ========================================================= */

  function normalizeSelection() {
    selection = {
      r1: Math.min(
        selection.r1,
        selection.r2
      ),
      c1: Math.min(
        selection.c1,
        selection.c2
      ),
      r2: Math.max(
        selection.r1,
        selection.r2
      ),
      c2: Math.max(
        selection.c1,
        selection.c2
      )
    };
  }


  function isInSelection(r, c) {
    return (
      r >= selection.r1 &&
      r <= selection.r2 &&
      c >= selection.c1 &&
      c <= selection.c2
    );
  }


  function updateSelectionUI() {
    sheetTable
      .querySelectorAll(".sheet-cell")
      .forEach(td => {

        td.classList.remove(
          "selected",
          "selected-range",
          "active-cell"
        );

        const r =
          Number(td.dataset.row);

        const c =
          Number(td.dataset.col);

        if (isInSelection(r, c)) {
          td.classList.add(
            "selected-range"
          );
        }

        if (
          r === activeCell.r &&
          c === activeCell.c
        ) {
          td.classList.add(
            "active-cell"
          );
        }
      });

    selectionStatus.textContent =
      `选择范围: ${getSelectionAddress()}`;
  }


  function getSelectionAddress() {
    const start =
      XLSX.utils.encode_cell({
        r: selection.r1,
        c: selection.c1
      });

    const end =
      XLSX.utils.encode_cell({
        r: selection.r2,
        c: selection.c2
      });

    return start === end
      ? start
      : `${start}:${end}`;
  }


  /* =========================================================
     获取 / 创建 cell 对象
     ========================================================= */

  function ensureCell(ws, r, c) {
    const address =
      XLSX.utils.encode_cell({
        r,
        c
      });

    if (!ws[address]) {
      ws[address] = {
        t: "s",
        v: ""
      };
    }

    ws[address].s =
      ws[address].s || {};

    return ws[address];
  }


  function getActiveCellObject() {
    const ws = getCurrentSheet();

    if (!ws) return null;

    return ensureCell(
      ws,
      activeCell.r,
      activeCell.c
    );
  }


  function forEachSelectedCell(callback) {
    const ws = getCurrentSheet();

    if (!ws) return;

    for (
      let r = selection.r1;
      r <= selection.r2;
      r++
    ) {
      for (
        let c = selection.c1;
        c <= selection.c2;
        c++
      ) {
        callback(
          ensureCell(ws, r, c),
          r,
          c
        );
      }
    }

    updateSheetRef(ws);
  }


  /* =========================================================
     样式修改
     ========================================================= */

  function applyStyle(
    modifier,
    rerender = true
  ) {
    if (!workbook) return;

    pushHistory();

    forEachSelectedCell(cell => {
      cell.s = clone(cell.s || {});
      modifier(cell.s, cell);
    });

    redoStack = [];

    if (rerender) {
      renderSheet();
    }

    updateFormulaBar();
    setStatus("已应用单元格格式");
  }


  /* =========================================================
     边框
     ========================================================= */

  function applyAllBorders() {
    applyStyle(style => {
      const border = {
        style: "thin",
        color: {
          rgb: "FF808080"
        }
      };

      style.border = {
        top: clone(border),
        bottom: clone(border),
        left: clone(border),
        right: clone(border)
      };
    });

    setStatus("已添加边框");
  }


  /* =========================================================
     清除格式
     ========================================================= */

  function clearCellFormatting() {
    pushHistory();

    forEachSelectedCell(cell => {
      cell.s = {};
      delete cell.z;
    });

    redoStack = [];

    renderSheet();
    updateFormulaBar();

    setStatus("已清除格式");
  }


  /* =========================================================
     Style => CSS
     ========================================================= */

  function applyCellStyleToElement(
    element,
    style
  ) {
    if (!style) return;


    /* 字体 */

    if (style.font) {
      if (style.font.name) {
        element.style.fontFamily =
          style.font.name;
      }

      if (style.font.sz) {
        element.style.fontSize =
          style.font.sz + "pt";
      }

      if (style.font.bold) {
        element.style.fontWeight =
          "bold";
      }

      if (style.font.italic) {
        element.style.fontStyle =
          "italic";
      }

      if (style.font.underline) {
        element.style.textDecoration =
          "underline";
      }

      const fontColor =
        extractColor(style.font.color);

      if (fontColor) {
        element.style.color =
          fontColor;
      }
    }


    /* 填充 */

    if (style.fill) {
      const fillColor =
        extractColor(
          style.fill.fgColor ||
          style.fill.bgColor
        );

      if (fillColor) {
        element.style.backgroundColor =
          fillColor;
      }
    }


    /* 对齐 */

    if (style.alignment) {
      if (
        style.alignment.horizontal
      ) {
        const map = {
          left: "left",
          center: "center",
          right: "right",
          justify: "justify"
        };

        element.style.textAlign =
          map[
            style.alignment.horizontal
          ] || "";
      }

      if (style.alignment.vertical) {
        const map = {
          top: "top",
          center: "middle",
          bottom: "bottom"
        };

        element.style.verticalAlign =
          map[
            style.alignment.vertical
          ] || "middle";
      }

      if (style.alignment.wrapText) {
        element.style.whiteSpace =
          "pre-wrap";
      }
    }


    /* 边框 */

    if (style.border) {
      applyBorderSide(
        element,
        "top",
        style.border.top
      );

      applyBorderSide(
        element,
        "right",
        style.border.right
      );

      applyBorderSide(
        element,
        "bottom",
        style.border.bottom
      );

      applyBorderSide(
        element,
        "left",
        style.border.left
      );
    }
  }


  function applyBorderSide(
    element,
    side,
    border
  ) {
    if (!border?.style) return;

    const color =
      extractColor(border.color) ||
      "#808080";

    const widths = {
      thin: "1px",
      medium: "2px",
      thick: "3px",
      hair: "1px",
      double: "3px"
    };

    const styles = {
      dashed: "dashed",
      dotted: "dotted",
      double: "double"
    };

    const width =
      widths[border.style] || "1px";

    const cssStyle =
      styles[border.style] || "solid";

    element.style[
      "border" +
      capitalize(side)
    ] =
      `${width} ${cssStyle} ${color}`;
  }


  /* =========================================================
     工具栏跟随当前单元格
     ========================================================= */

  function updateToolbarFromCell() {
    const cell =
      getActiveCellObject();

    if (!cell) return;

    const style =
      cell.s || {};

    const font =
      style.font || {};

    boldBtn.classList.toggle(
      "active",
      !!font.bold
    );

    italicBtn.classList.toggle(
      "active",
      !!font.italic
    );

    underlineBtn.classList.toggle(
      "active",
      !!font.underline
    );

    if (font.name) {
      setSelectIfExists(
        fontNameSelect,
        font.name
      );
    }

    if (font.sz) {
      setSelectIfExists(
        fontSizeSelect,
        String(font.sz)
      );
    }

    if (cell.z) {
      setSelectIfExists(
        numberFormatSelect,
        cell.z
      );
    }
  }


  /* =========================================================
     合并单元格
     ========================================================= */

  function mergeSelectedCells() {
    if (
      selection.r1 === selection.r2 &&
      selection.c1 === selection.c2
    ) {
      alert("请至少选择两个单元格。");
      return;
    }

    const ws = getCurrentSheet();

    pushHistory();

    ws["!merges"] =
      ws["!merges"] || [];

    /*
      防止重复/交叉合并
    */

    const intersects =
      ws["!merges"].some(range =>
        rangesIntersect(
          range,
          {
            s: {
              r: selection.r1,
              c: selection.c1
            },
            e: {
              r: selection.r2,
              c: selection.c2
            }
          }
        )
      );

    if (intersects) {
      alert(
        "所选区域与已有合并单元格发生重叠，请先取消原合并。"
      );

      undoStack.pop();
      return;
    }

    ws["!merges"].push({
      s: {
        r: selection.r1,
        c: selection.c1
      },
      e: {
        r: selection.r2,
        c: selection.c2
      }
    });

    /*
      Excel 合并后只保留左上角内容。
    */

    for (
      let r = selection.r1;
      r <= selection.r2;
      r++
    ) {
      for (
        let c = selection.c1;
        c <= selection.c2;
        c++
      ) {
        if (
          r === selection.r1 &&
          c === selection.c1
        ) {
          continue;
        }

        const address =
          XLSX.utils.encode_cell({
            r,
            c
          });

        delete ws[address];
      }
    }

    redoStack = [];

    renderSheet();

    setStatus("已合并单元格");
  }


  function unmergeSelectedCells() {
    const ws = getCurrentSheet();

    if (
      !ws["!merges"] ||
      !ws["!merges"].length
    ) {
      return;
    }

    pushHistory();

    const target = {
      s: {
        r: selection.r1,
        c: selection.c1
      },
      e: {
        r: selection.r2,
        c: selection.c2
      }
    };

    ws["!merges"] =
      ws["!merges"].filter(
        range =>
          !rangesIntersect(
            range,
            target
          )
      );

    redoStack = [];

    renderSheet();

    setStatus("已取消合并单元格");
  }


  function applyMergeRendering(ws) {
    const merges =
      ws["!merges"] || [];

    merges.forEach(range => {
      if (
        range.s.r >= renderedRows ||
        range.s.c >= renderedCols
      ) {
        return;
      }

      const master =
        getCellElement(
          range.s.r,
          range.s.c
        );

      if (!master) return;

      const rowSpan =
        Math.min(
          range.e.r,
          renderedRows - 1
        ) -
        range.s.r +
        1;

      const colSpan =
        Math.min(
          range.e.c,
          renderedCols - 1
        ) -
        range.s.c +
        1;

      master.rowSpan = rowSpan;
      master.colSpan = colSpan;

      for (
        let r = range.s.r;
        r <= range.e.r;
        r++
      ) {
        for (
          let c = range.s.c;
          c <= range.e.c;
          c++
        ) {
          if (
            r === range.s.r &&
            c === range.s.c
          ) {
            continue;
          }

          const child =
            getCellElement(r, c);

          if (child) {
            child.style.display =
              "none";
          }
        }
      }
    });
  }


  function rangesIntersect(a, b) {
    return !(
      a.e.r < b.s.r ||
      a.s.r > b.e.r ||
      a.e.c < b.s.c ||
      a.s.c > b.e.c
    );
  }


  /* =========================================================
     工作表管理
     ========================================================= */

  function addSheet() {
    let index = 1;
    let name;

    do {
      name = "Sheet" + index++;
    } while (
      workbook.SheetNames.includes(name)
    );

    const requested =
      prompt(
        "请输入新工作表名称：",
        name
      );

    if (requested === null) {
      return;
    }

    const finalName =
      sanitizeSheetName(
        requested.trim() || name
      );

    if (
      workbook.SheetNames.includes(
        finalName
      )
    ) {
      alert("工作表名称已存在。");
      return;
    }

    pushHistory();

    const ws =
      XLSX.utils.aoa_to_sheet([
        [""]
      ]);

    XLSX.utils.book_append_sheet(
      workbook,
      ws,
      finalName
    );

    currentSheetName = finalName;

    activeCell = {
      r: 0,
      c: 0
    };

    selection = {
      r1: 0,
      c1: 0,
      r2: 0,
      c2: 0
    };

    renderedRows = 50;
    renderedCols = 20;

    redoStack = [];

    renderAll();

    setStatus(
      `已创建工作表：${finalName}`
    );
  }


  function renameCurrentSheet() {
    const oldName =
      currentSheetName;

    const name =
      prompt(
        "请输入新的工作表名称：",
        oldName
      );

    if (name === null) return;

    const newName =
      sanitizeSheetName(name.trim());

    if (!newName) {
      alert("工作表名称不能为空。");
      return;
    }

    if (
      newName !== oldName &&
      workbook.SheetNames.includes(
        newName
      )
    ) {
      alert("工作表名称已存在。");
      return;
    }

    if (newName === oldName) {
      return;
    }

    pushHistory();

    workbook.Sheets[newName] =
      workbook.Sheets[oldName];

    delete workbook.Sheets[oldName];

    const index =
      workbook.SheetNames.indexOf(
        oldName
      );

    workbook.SheetNames[index] =
      newName;

    currentSheetName = newName;

    redoStack = [];

    renderSheetTabs();

    setStatus(
      `工作表已重命名为：${newName}`
    );
  }


  function deleteCurrentSheet() {
    if (
      workbook.SheetNames.length <= 1
    ) {
      alert(
        "工作簿必须至少保留一个工作表。"
      );
      return;
    }

    if (
      !confirm(
        `确定删除工作表“${currentSheetName}”吗？`
      )
    ) {
      return;
    }

    pushHistory();

    const index =
      workbook.SheetNames.indexOf(
        currentSheetName
      );

    delete workbook.Sheets[
      currentSheetName
    ];

    workbook.SheetNames.splice(
      index,
      1
    );

    currentSheetName =
      workbook.SheetNames[
        Math.max(
          0,
          index - 1
        )
      ];

    redoStack = [];

    calculateRenderSize();

    activeCell = {
      r: 0,
      c: 0
    };

    selection = {
      r1: 0,
      c1: 0,
      r2: 0,
      c2: 0
    };

    renderAll();

    setStatus("工作表已删除");
  }


  function sanitizeSheetName(name) {
    /*
      Excel 禁止：
      \ / ? * [ ] :
      最大 31 字符
    */

    return name
      .replace(/[\\/?*[\]:]/g, "_")
      .substring(0, 31);
  }


  /* =========================================================
     多单元格粘贴
     ========================================================= */

  function handleCellPaste(
    event,
    startRow,
    startCol
  ) {
    event.preventDefault();

    const clipboard =
      event.clipboardData ||
      window.clipboardData;

    const text =
      clipboard.getData("text/plain");

    if (!text) return;

    const rows =
      text
        .replace(/\r/g, "")
        .split("\n");

    /*
      最后一行通常是剪贴板附带换行
    */

    if (
      rows.length > 1 &&
      rows[rows.length - 1] === ""
    ) {
      rows.pop();
    }

    const matrix =
      rows.map(
        row => row.split("\t")
      );

    pushHistory();

    const ws = getCurrentSheet();

    let maxRow = startRow;
    let maxCol = startCol;

    matrix.forEach(
      (row, rowOffset) => {

        row.forEach(
          (value, colOffset) => {

            const r =
              startRow + rowOffset;

            const c =
              startCol + colOffset;

            setCellValue(
              ws,
              r,
              c,
              value,
              true
            );

            maxRow =
              Math.max(maxRow, r);

            maxCol =
              Math.max(maxCol, c);
          }
        );
      }
    );

    renderedRows =
      Math.max(
        renderedRows,
        maxRow + 5
      );

    renderedCols =
      Math.max(
        renderedCols,
        maxCol + 3
      );

    selection = {
      r1: startRow,
      c1: startCol,
      r2: maxRow,
      c2: maxCol
    };

    activeCell = {
      r: startRow,
      c: startCol
    };

    updateSheetRef(ws);

    redoStack = [];

    renderSheet();
    updateFormulaBar();

    setStatus(
      `已粘贴 ${matrix.length}×${Math.max(
        ...matrix.map(row => row.length)
      )} 区域`
    );
  }


  /* =========================================================
     Undo / Redo
     ========================================================= */

  function pushHistory() {
    if (!workbook) return;

    undoStack.push(
      clone(workbook)
    );

    if (
      undoStack.length >
      MAX_HISTORY
    ) {
      undoStack.shift();
    }
  }


  function undo() {
    if (
      undoStack.length === 0
    ) {
      setStatus("没有可撤销的操作");
      return;
    }

    redoStack.push(
      clone(workbook)
    );

    workbook =
      undoStack.pop();

    restoreSheetAfterHistory();

    setStatus("已撤销");
  }


  function redo() {
    if (
      redoStack.length === 0
    ) {
      setStatus("没有可重做的操作");
      return;
    }

    undoStack.push(
      clone(workbook)
    );

    workbook =
      redoStack.pop();

    restoreSheetAfterHistory();

    setStatus("已重做");
  }


  function restoreSheetAfterHistory() {
    if (
      !workbook.SheetNames.includes(
        currentSheetName
      )
    ) {
      currentSheetName =
        workbook.SheetNames[0];
    }

    calculateRenderSize();
    renderAll();
  }


  /* =========================================================
     更新 !ref
     ========================================================= */

  function updateSheetRef(ws) {
    let maxR = 0;
    let maxC = 0;

    Object.keys(ws).forEach(key => {
      if (key.startsWith("!")) {
        return;
      }

      try {
        const cell =
          XLSX.utils.decode_cell(key);

        maxR =
          Math.max(maxR, cell.r);

        maxC =
          Math.max(maxC, cell.c);
      } catch (e) {
        /* 忽略 */
      }
    });

    if (ws["!merges"]) {
      ws["!merges"].forEach(merge => {
        maxR =
          Math.max(
            maxR,
            merge.e.r
          );

        maxC =
          Math.max(
            maxC,
            merge.e.c
          );
      });
    }

    ws["!ref"] =
      XLSX.utils.encode_range({
        s: {
          r: 0,
          c: 0
        },
        e: {
          r: maxR,
          c: maxC
        }
      });
  }


  /* =========================================================
     导出
     ========================================================= */

  /* =========================================================
     导出
     ========================================================= */

  function buildWorkbookBlob() {
    /*
      对所有 Sheet 更新 !ref
    */

    workbook.SheetNames.forEach(
      sheetName => {
        updateSheetRef(
          workbook.Sheets[
            sheetName
          ]
        );
      }
    );

    const array =
      XLSX.write(
        workbook,
        {
          bookType: "xlsx",
          type: "array",
          cellStyles: true,
          compression: true
        }
      );

    return new Blob(
      [array],
      {
        type:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      }
    );
  }

  function exportWorkbook() {
    if (!workbook) {
      alert("没有可导出的工作簿。");
      return;
    }

    if (
      typeof XLSX === "undefined"
    ) {
      alert(
        "XLSX 库加载失败。"
      );
      return;
    }

    setStatus(
      "正在生成 Excel 文件..."
    );

    try {
      saveAs(
        buildWorkbookBlob(),
        originalFileName ||
        "workbook.xlsx"
      );

      setStatus("Excel 文件已导出");

    } catch (error) {
      console.error(error);

      setStatus("导出失败");

      alert(
        "导出 Excel 时发生错误：" +
        error.message
      );
    }
  }



  /* =========================================================
     DOM 辅助
     ========================================================= */

  function getCellElement(r, c) {
    return sheetTable.querySelector(
      `.sheet-cell[data-row="${r}"][data-col="${c}"]`
    );
  }


  /* =========================================================
     Color
     ========================================================= */

  function colorToARGB(hex) {
    return (
      "FF" +
      hex.replace("#", "").toUpperCase()
    );
  }


  function extractColor(color) {
    if (!color) return null;

    if (color.rgb) {
      let rgb =
        color.rgb.replace("#", "");

      /*
        ARGB => RGB
      */

      if (rgb.length === 8) {
        rgb = rgb.substring(2);
      }

      if (rgb.length === 6) {
        return "#" + rgb;
      }
    }

    /*
      theme/indexed color 需要完整主题映射，
      简化编辑器不进行转换。
    */

    return null;
  }


  /* =========================================================
     Date
     ========================================================= */

  function formatDate(date) {
    if (!(date instanceof Date)) {
      return String(date);
    }

    const yyyy =
      date.getFullYear();

    const mm =
      String(
        date.getMonth() + 1
      ).padStart(2, "0");

    const dd =
      String(
        date.getDate()
      ).padStart(2, "0");

    return `${yyyy}-${mm}-${dd}`;
  }


  /* =========================================================
     Misc
     ========================================================= */

  function clone(value) {
    /*
      structuredClone 可以正确处理 Date。
    */

    if (
      typeof structuredClone ===
      "function"
    ) {
      return structuredClone(value);
    }

    return JSON.parse(
      JSON.stringify(value)
    );
  }


  function setSelectIfExists(
    select,
    value
  ) {
    const exists =
      Array.from(
        select.options
      ).some(
        option =>
          option.value === value
      );

    if (exists) {
      select.value = value;
    }
  }


  function capitalize(value) {
    return (
      value.charAt(0).toUpperCase() +
      value.slice(1)
    );
  }


  function setStatus(message) {
    statusSpan.textContent = message;
  }



  /* =========================================================
     almostnode 宿主集成（index.html 的 Office 编辑器 iframe）：
     - load  : 接收宿主传来的工作簿字节并载入
     - export: 把当前工作簿生成的 XLSX 字节回传给宿主
     ========================================================= */

  function loadWorkbookFromBuffer(arrayBuffer) {
    try {
      workbook = XLSX.read(
        arrayBuffer,
        {
          type: "array",

          /* 保留基本样式 */
          cellStyles: true,

          /* 保留公式 */
          cellFormula: true,

          /* 保留数字格式 */
          cellNF: true,

          /* 保留富文本对应值 */
          cellHTML: true,

          /* 日期作为 Date */
          cellDates: true
        }
      );

      if (
        !workbook ||
        !workbook.SheetNames ||
        workbook.SheetNames.length === 0
      ) {
        throw new Error("工作簿中没有工作表");
      }

      currentSheetName = workbook.SheetNames[0];

      calculateRenderSize();

      activeCell = {
        r: 0,
        c: 0
      };

      selection = {
        r1: 0,
        c1: 0,
        r2: 0,
        c2: 0
      };

      undoStack = [];
      redoStack = [];

      renderAll();

      setStatus("工作簿已就绪，可开始编辑");
    } catch (error) {
      console.error(error);

      alert(
        "无法读取 Excel 文件：" +
        error.message
      );

      setStatus("文件读取失败");
    }
  }

  function pgpySend(msg) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(Object.assign({ source: "pgpy" }, msg), "*");
      }
    } catch (e) {}
  }

  function pgpyToArrayBuffer(buf) {
    if (buf instanceof ArrayBuffer) return buf;
    return new Uint8Array(buf).buffer;
  }

  window.addEventListener("message", function(e) {
    const d = e.data || {};
    if (d.source !== "pgpy") return;

    if (d.type === "load") {
      if (!d.buffer) return;
      const name = d.fileName || "workbook.xlsx";
      fileNameSpan.textContent = name;
      originalFileName =
        name.replace(/\.[^.]+$/i, "") +
        "_编辑版.xlsx";
      loadWorkbookFromBuffer(pgpyToArrayBuffer(d.buffer));
      pgpySend({ type: "loaded", fileName: originalFileName });
    } else if (d.type === "export") {
      const reqId = d.id;
      try {
        if (!workbook) throw new Error("没有可导出的工作簿");
        const blob = buildWorkbookBlob();
        blob.arrayBuffer()
          .then(buf => pgpySend({ type: "export-result", id: reqId, buffer: buf, fileName: originalFileName || "workbook.xlsx" }))
          .catch(err => pgpySend({ type: "error", id: reqId, message: String((err && err.message) || err) }));
      } catch (err) {
        pgpySend({ type: "error", id: reqId, message: String((err && err.message) || err) });
      }
    }
  });

  pgpySend({ type: "ready" });

  document.addEventListener(
    "DOMContentLoaded",
    init
  );



    function xlsxEditorIsActive() {
        var el = document.getElementById('xlsxEditorRoot');
        return !!(el && el.offsetParent !== null);
    }


    // API 暴露给宿主 index.html
    window.__xlsxEditor = {
        load: function(arrayBuffer, fileName) {
            var ab = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : new Uint8Array(arrayBuffer).buffer;
            if (fileName) {
                fileNameSpan.textContent = fileName;
                originalFileName = String(fileName).replace(/\.[^.]+$/i, "") + "_编辑版.xlsx";
            }
            loadWorkbookFromBuffer(ab);
        },
        export: function() {
            if (!workbook) { throw new Error("没有可导出的工作簿"); }
            return buildWorkbookBlob().arrayBuffer().then(function(buf){
                return { buffer: buf, fileName: originalFileName || "workbook.xlsx" };
            });
        }
    };

})();
