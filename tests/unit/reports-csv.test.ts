import { describe, expect, it } from "vitest";
import {
  csvField,
  csvFilename,
  csvLine,
  neutraliseFormula,
  toCsv,
} from "@/lib/reports/csv";
import { row } from "@/lib/reports/result";
import type { ReportResult } from "@/lib/reports/result";

/**
 * The export file.
 *
 * Two failure modes, and they are not the same kind of problem. A quoting bug
 * misaligns columns and somebody notices. A formula-injection bug runs code on
 * the machine of the accountant who opened the file, and nobody notices at all.
 */

describe("quoting", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvField("Rice 25kg")).toBe("Rice 25kg");
    expect(csvField("1234.5600")).toBe("1234.5600");
  });

  it("quotes a value containing the delimiter", () => {
    // Without this the product becomes two columns and every figure to its
    // right shifts one place.
    expect(csvField("Rice, 25kg")).toBe('"Rice, 25kg"');
  });

  it("doubles an embedded quote", () => {
    expect(csvField('Rice "premium"')).toBe('"Rice ""premium"""');
  });

  it("quotes a value containing a newline", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"');
  });

  it("quotes leading and trailing space, which a reader would otherwise eat", () => {
    expect(csvField(" padded ")).toBe('" padded "');
  });

  it("joins a row with commas", () => {
    expect(csvLine(["a", "b,c", "d"])).toBe('a,"b,c",d');
  });
});

describe("formula injection", () => {
  it("defuses every character a spreadsheet treats as a formula", () => {
    for (const dangerous of [
      "=1+1",
      "+1",
      "@SUM(A1)",
      "=cmd|'/c calc'!A1",
      "\tinjected",
    ]) {
      expect(neutraliseFormula(dangerous).startsWith("'")).toBe(true);
    }
  });

  it("defuses through the quoting layer too", () => {
    // A payload with no comma or quote needs no wrapping, and is still defused
    // — quoting was never the defence here, because a quoted field is
    // evaluated just the same.
    expect(csvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    // And when it does need wrapping, it gets both.
    expect(csvField('=HYPERLINK("http://x","click")')).toBe(
      `"'=HYPERLINK(""http://x"",""click"")"`,
    );
  });

  it("leaves a negative figure exactly as it is", () => {
    // Every ledger is full of these, and mangling them to guard against a
    // formula nobody wrote would be its own kind of wrong.
    expect(neutraliseFormula("-472.0000")).toBe("-472.0000");
    expect(neutraliseFormula("-0.5")).toBe("-0.5");
    expect(csvField("-1180.0000")).toBe("-1180.0000");
  });

  it("still defuses text that merely begins with a minus", () => {
    expect(neutraliseFormula("-not a number")).toBe("'-not a number");
  });
});

const REPORT: ReportResult = {
  key: "trial-balance",
  title: "Trial balance",
  period: "1 Apr 2026 to 31 Mar 2027",
  columns: [
    { key: "account", label: "Account", kind: "text" },
    { key: "debit", label: "Debit", kind: "money" },
  ],
  rows: [
    row({ account: "Assets" }, "group"),
    row({ account: "1001 · Cash", debit: "1000.0000" }),
    row({ account: "Total", debit: "1000.0000" }, "total"),
  ],
  notes: ["Debits equal credits."],
  empty: false,
};

describe("the whole file", () => {
  const csv = toCsv(REPORT);
  const lines = csv.split("\r\n");

  it("names the report and its period before any figure", () => {
    // A file that says only "1,000.00" with no statement of what it covers is
    // a figure somebody will quote out of context, and the export is the copy
    // that travels.
    expect(lines[0]).toBe("Trial balance");
    expect(lines[1]).toBe("1 Apr 2026 to 31 Mar 2027");
  });

  it("writes the header row and every body row", () => {
    expect(lines[3]).toBe("Account,Debit");
    expect(lines[4]).toBe("Assets,");
    expect(lines[5]).toBe("1001 · Cash,1000.0000");
  });

  it("carries the notes into the file", () => {
    expect(csv).toContain("Debits equal credits.");
  });

  it("keeps money exactly as the service produced it", () => {
    // Not "₹1,000.00": a spreadsheet cannot add that up.
    expect(csv).toContain("1000.0000");
    expect(csv).not.toContain("₹");
  });

  it("uses CRLF, which is what the format specifies", () => {
    expect(csv.includes("\r\n")).toBe(true);
  });

  it("emits a cell for every column, including missing ones", () => {
    // A group row has no debit. It must still occupy its column, or the file
    // is ragged and the reader silently shifts the rest of the row.
    for (const line of lines.slice(3, 6)) {
      expect(line.split(",").length).toBe(2);
    }
  });
});

describe("filename", () => {
  it("says what it is and sorts by date", () => {
    expect(csvFilename("trial-balance", new Date("2026-08-14T09:00:00Z"))).toBe(
      "trial-balance-2026-08-14.csv",
    );
  });
});
