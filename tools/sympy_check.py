#!/usr/bin/env python
"""Пересчёт numeric-ответов теста через SymPy.

Читает quiz.json из stdin, для каждого numeric-вопроса с полем "sympy"
вычисляет выражение и сверяет с correct (в пределах tolerance).
Выражения выполняются в ограниченном пространстве имён — никакого exec/import.
Выход: JSON-отчёт в stdout; код 1, если есть расхождения.
"""
import json
import sys

from sympy import (E, N, Rational, cos, diff, exp, integrate, limit, log, oo,
                   pi, sin, sqrt, summation, symbols, tan)

x, n, t, k = symbols("x n t k")
SAFE = {
    "limit": limit, "integrate": integrate, "diff": diff, "summation": summation,
    "sqrt": sqrt, "sin": sin, "cos": cos, "tan": tan, "log": log, "exp": exp,
    "pi": pi, "E": E, "oo": oo, "Rational": Rational, "N": N,
    "x": x, "n": n, "t": t, "k": k,
}

quiz = json.load(sys.stdin)
report, failed = [], False

for q in quiz.get("questions", []):
    if q.get("type") != "numeric":
        continue
    entry = {"id": q.get("id"), "correct": q.get("correct")}
    expr = q.get("sympy")
    if not expr:
        entry["status"] = "no_sympy"  # генератор обязан давать sympy — ловим в конвейере
        failed = True
        report.append(entry)
        continue
    try:
        value = float(N(eval(expr, {"__builtins__": {}}, SAFE)))  # noqa: S307 — allowlist выше
        entry["computed"] = value
        tol = max(q.get("tolerance", 0), 1e-9)
        if abs(value - float(q["correct"])) <= tol:
            entry["status"] = "ok"
        else:
            entry["status"] = "MISMATCH"
            failed = True
    except Exception as exc:  # выражение не вычислилось — тоже провал
        entry["status"] = "error"
        entry["detail"] = f"{type(exc).__name__}: {exc}"
        failed = True
    report.append(entry)

json.dump({"checked": len(report), "failed": failed, "results": report},
          sys.stdout, ensure_ascii=False, indent=2)
sys.exit(1 if failed else 0)
