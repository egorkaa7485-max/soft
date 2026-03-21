#NoEnv
#SingleInstance Force
SendMode Input
SetTitleMatchMode, 2
SetWinDelay, -1
#InstallKeybdHook
#InstallMouseHook

; ===== Настройки сетки =====
cols := 10
rows := 2
margin := 3
border := 2
gridAlpha := 110
gridColor := "00E5FF"

selected := []
selectedMap := {}

; ===== Work area (без панели задач) =====
SysGet, L, 76
SysGet, T, 77
SysGet, R, 78
SysGet, B, 79
workW := R - L
workH := B - T
cellW := Floor(workW / cols)
cellH := Floor(workH / rows)

; ===== GUI сетки =====
Gui, Grid:New, +AlwaysOnTop -Caption +ToolWindow +E0x20 +LastFound
gridHwnd := WinExist()
Gui, Grid:Color, 000001
WinSet, TransColor, 000001 %gridAlpha%
Gui, Grid:Font, s14 Bold, Segoe UI

Loop, % (cols * rows) {
    i := A_Index
    col := Mod(i-1, cols)
    row := Floor((i-1) / cols)

    x0 := col * cellW
    y0 := row * cellH

    x := x0 + margin
    y := y0 + margin
    w := cellW - (margin*2)
    h := cellH - (margin*2)

    ; top
    opt := "x" x " y" y " w" w " h" border " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100

    ; bottom
    yb := y + h - border
    opt := "x" x " y" yb " w" w " h" border " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100

    ; left
    opt := "x" x " y" y " w" border " h" h " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100

    ; right
    xr := x + w - border
    opt := "x" xr " y" y " w" border " h" h " Background" gridColor " c" gridColor
    Gui, Grid:Add, Progress, %opt%, 100

    ; Номер зоны
    tx := x + 8
    ty := y + 6
    opt := "x" tx " y" ty " c" gridColor " BackgroundTrans"
    Gui, Grid:Add, Text, %opt%, %i%
}

Gui, Grid:Show, x%L% y%T% w%workW% h%workH% NoActivate, Tile20Grid

MsgBox, 64, Tile20, Скрипт запущен (AHK v1).`n`nF6 = взять окно под мышью и поставить`nF7 = переложить`nF8 = сброс`nF9 = сетка вкл/выкл

*F9::ToggleGrid()
*F8::ResetAll()
*F7::RetileAll()
*F6::AddAndTileUnderMouse()
return

ToggleGrid() {
    static visible := true
    if (visible) {
        Gui, Grid:Hide
        visible := false
        ToolTip, Сетка скрыта (F9 показать).
    } else {
        Gui, Grid:Show, NoActivate
        visible := true
        ToolTip, Сетка показана.
    }
    SetTimer, __ttoff, -900
}

ResetAll() {
    global selected, selectedMap
    selected := []
    selectedMap := {}
    ToolTip, Список очищен (F6 добавлять заново).
    SoundBeep, 650, 80
    SetTimer, __ttoff, -1200
}

AddAndTileUnderMouse() {
    global selected, selectedMap, gridHwnd

    MouseGetPos, , , hwnd
    if (!hwnd) {
        ToolTip, Не нашёл окно под мышью.
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1200
        return
    }
    if (hwnd = gridHwnd) {
        ToolTip, Наведи на настоящее окно (не на сетку).
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1200
        return
    }

    WinGet, top, ID, ahk_id %hwnd%
    if (!top)
        top := hwnd

    if (!selectedMap.HasKey(top)) {
        selectedMap[top] := true
        selected.Push(top)
    }

    cnt := selected.Length()
    if (cnt > 20) {
        ToolTip, Уже больше 20. Нажми F8 (сброс).
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1500
        return
    }

    TileOne(top, cnt)

    WinGetTitle, title, ahk_id %top%
    ToolTip, Поставлено: %cnt%/20`n%title%
    SoundBeep, 900, 40
    SetTimer, __ttoff, -1200
}

RetileAll() {
    global selected
    cnt := selected.Length()
    if (cnt < 1) {
        ToolTip, Список пуст. Добавляй окна F6.
        SoundBeep, 350, 120
        SetTimer, __ttoff, -1200
        return
    }
    max := (cnt < 20) ? cnt : 20
    Loop, %max% {
        hwnd := selected[A_Index]
        TileOne(hwnd, A_Index)
    }
    ToolTip, Переложено окон: %max%.
    SoundBeep, 700, 80
    SetTimer, __ttoff, -1200
}

TileOne(hwnd, idx) {
    global cols, L, T, R, B, cellW, cellH, margin

    col := Mod(idx-1, cols)
    row := Floor((idx-1) / cols)

    x0 := L + col * cellW
    y0 := T + row * cellH

    x := x0 + margin
    y := y0 + margin

    if (col = cols-1)
        w := (R - x0) - (margin*2)
    else
        w := cellW - (margin*2)

    if (row = 1) ; rows=2, значит последняя строка имеет индекс 1
        h := (B - y0) - (margin*2)
    else
        h := cellH - (margin*2)

    Win