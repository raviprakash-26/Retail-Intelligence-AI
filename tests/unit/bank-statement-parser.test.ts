import { describe, expect, it } from "vitest";
import {
  parseBankStatement,
  parseCsv,
  parseStatementDate,
  StatementFormatError,
} from "@/lib/banking/statement-parser";

/**
 * Reading a bank statement.
 *
 * The cases here are the shapes real Indian bank exports actually take, and the
 * failures are the ones that would corrupt a reconciliation silently: a
 * misread direction, a lakh-grouped amount read as a small one, a day-first
 * date read month-first.
 */

describe("the CSV reader", () => {
  it("keeps commas that are inside a quoted description", () => {
    // The reason this is not a `split(",")`: a narration with a comma in it
    // would shift every column after it, and the amount would be read from the
    // wrong cell rather than failing.
    const rows = parseCsv(
      'Date,Narration,Withdrawal,Deposit\n01/04/2026,"NEFT DR-SBIN01234-RAJESH, BANGALORE",5000.00,\n',
    );
    expect(rows[1]).toEqual([
      "01/04/2026",
      "NEFT DR-SBIN01234-RAJESH, BANGALORE",
      "5000.00",
      "",
    ]);
  });

  it("reads a doubled quote as one quote", () => {
    const rows = parseCsv('A\n"say ""hello"""\n');
    expect(rows[1]).toEqual(['say "hello"']);
  });

  it("reads the last row of a file with no trailing newline", () => {
    const rows = parseCsv("Date,Amount\n01/04/2026,100");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(["01/04/2026", "100"]);
  });

  it("handles CRLF, which is what a Windows export produces", () => {
    const rows = parseCsv("Date,Amount\r\n01/04/2026,100\r\n");
    expect(rows[1]).toEqual(["01/04/2026", "100"]);
  });

  it("drops blank rows rather than reporting them as errors", () => {
    const rows = parseCsv("Date,Amount\n\n01/04/2026,100\n,\n");
    expect(rows).toHaveLength(2);
  });
});

describe("reading dates", () => {
  it("reads an Indian statement date as day-first", () => {
    // 03/04/2026 is 3 April on every bank statement printed in India. Reading
    // it as 4 March would move the transaction into another month, and a
    // reconciliation is a claim about a month.
    const date = parseStatementDate("03/04/2026");
    expect(date?.toISOString().slice(0, 10)).toBe("2026-04-03");
  });

  it("still reads an ISO date as ISO", () => {
    expect(parseStatementDate("2026-04-03")?.toISOString().slice(0, 10)).toBe(
      "2026-04-03",
    );
  });

  it("reads a named month", () => {
    expect(parseStatementDate("03-Apr-2026")?.toISOString().slice(0, 10)).toBe(
      "2026-04-03",
    );
  });

  it("refuses a date that does not exist rather than rolling it forward", () => {
    // JavaScript would turn 31 February into 3 March without complaint.
    expect(parseStatementDate("31/02/2026")).toBeNull();
    expect(parseStatementDate("32/01/2026")).toBeNull();
  });

  it("returns null for something that is not a date", () => {
    expect(parseStatementDate("opening balance")).toBeNull();
    expect(parseStatementDate("")).toBeNull();
  });
});

describe("a statement with withdrawal and deposit columns", () => {
  const csv = [
    "Txn Date,Value Date,Description,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance",
    '01/04/2026,01/04/2026,By Cash Deposit,,,25000.00,"1,25,000.00"',
    '03/04/2026,03/04/2026,NEFT DR-SHARMA TRADERS,234567,12500.50,,"1,12,499.50"',
  ].join("\n");

  it("reads money in as IN and money out as OUT", () => {
    // The direction convention, which is the single most confusable thing in
    // the module: the bank's Deposit column is money arriving, which in our
    // books debits the bank asset.
    const { rows, errors } = parseBankStatement(csv);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);

    expect(rows[0]?.direction).toBe("IN");
    expect(rows[0]?.amount.toString()).toBe("25000");
    expect(rows[1]?.direction).toBe("OUT");
    expect(rows[1]?.amount.toString()).toBe("12500.5");
  });

  it("reads a lakh-grouped balance as the figure it is", () => {
    // "1,25,000.00" is one lakh twenty-five thousand, not 1.25.
    const { rows } = parseBankStatement(csv);
    expect(rows[0]?.runningBalance?.toString()).toBe("125000");
  });

  it("keeps the reference and the value date", () => {
    const { rows } = parseBankStatement(csv);
    expect(rows[1]?.referenceNo).toBe("234567");
    expect(rows[0]?.referenceNo).toBeNull();
    expect(rows[0]?.valueDate?.toISOString().slice(0, 10)).toBe("2026-04-01");
  });

  it("falls back to the value date when it is the only date in the file", () => {
    const { rows, errors } = parseBankStatement(
      [
        "Value Date,Description,Withdrawal,Deposit",
        "03/04/2026,Rent,18000,",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows[0]?.txnDate.toISOString().slice(0, 10)).toBe("2026-04-03");
    // It was used as the transaction date, so it is not also reported as a
    // separate value date.
    expect(rows[0]?.valueDate).toBeNull();
  });

  it("does not mistake the value date column for the transaction date", () => {
    const { rows } = parseBankStatement(
      [
        "Value Date,Txn Date,Description,Withdrawal,Deposit",
        "05/04/2026,03/04/2026,Cheque cleared,1000,",
      ].join("\n"),
    );
    expect(rows[0]?.txnDate.toISOString().slice(0, 10)).toBe("2026-04-03");
    expect(rows[0]?.valueDate?.toISOString().slice(0, 10)).toBe("2026-04-05");
  });
});

describe("a statement with one amount column", () => {
  it("uses the Dr/Cr indicator to decide direction", () => {
    const { rows, errors } = parseBankStatement(
      [
        "Date,Particulars,Amount,Dr/Cr",
        "01/04/2026,Rent paid,18000,Dr",
        "02/04/2026,Sale settlement,4200,Cr",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows[0]?.direction).toBe("OUT");
    expect(rows[1]?.direction).toBe("IN");
  });

  it("uses the sign when there is no indicator", () => {
    const { rows } = parseBankStatement(
      ["Date,Particulars,Amount", "01/04/2026,Rent paid,-18000"].join("\n"),
    );
    expect(rows[0]?.direction).toBe("OUT");
    expect(rows[0]?.amount.toString()).toBe("18000");
  });

  it("reads the Dr or Cr written onto the amount itself", () => {
    // A passbook-style export puts the direction in the cell rather than in a
    // column of its own. `parseAmount` has to strip the marker to read the
    // number, and stripping it threw away the only thing on the row that said
    // which way the money went — so every withdrawal came through as a deposit,
    // with no error against the row to say so.
    const { rows, errors } = parseBankStatement(
      [
        "Date,Particulars,Amount",
        '01/04/2026,ATM cash withdrawal,"5,000.00 Dr"',
        '02/04/2026,Card settlement,"4,200.00 Cr"',
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows[0]?.direction).toBe("OUT");
    expect(rows[0]?.amount.toString()).toBe("5000");
    expect(rows[1]?.direction).toBe("IN");
    expect(rows[1]?.amount.toString()).toBe("4200");
  });

  it("reads the marker whichever end of the number it sits", () => {
    const { rows, errors } = parseBankStatement(
      [
        "Date,Particulars,Amount",
        "01/04/2026,Rent paid,18000 Dr",
        "02/04/2026,Cheque deposited,Cr 9000",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows[0]?.direction).toBe("OUT");
    expect(rows[1]?.direction).toBe("IN");
  });

  it("reports a marker jammed against the digits rather than guessing", () => {
    // "18000Dr" is a cell neither the amount reader nor the marker reader can
    // take apart with certainty, and they have to agree about that: a marker
    // seen here but not stripped there would leave a direction with no
    // readable amount.
    const { rows, errors } = parseBankStatement(
      ["Date,Particulars,Amount", "01/04/2026,Rent paid,18000Dr"].join("\n"),
    );
    expect(rows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("refuses a row where the marker and the indicator disagree", () => {
    // One of the two is wrong and there is nothing here that can say which.
    const { rows, errors } = parseBankStatement(
      ["Date,Particulars,Amount,Dr/Cr", "01/04/2026,Something,5000 Dr,Cr"].join(
        "\n",
      ),
    );
    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toMatch(/money in or money out/i);
  });

  it("refuses a row whose direction cannot be told, instead of guessing", () => {
    // An unsigned amount with no indicator could be either way round. Assuming
    // one would put the reconciliation out by twice the amount — the worst kind
    // of wrong, because it looks like a real discrepancy somewhere else.
    const { rows, errors } = parseBankStatement(
      [
        "Date,Particulars,Amount,Type",
        "01/04/2026,Something,18000,Miscellaneous",
      ].join("\n"),
    );
    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toMatch(/money in or money out/i);
    expect(errors[0]?.lineNumber).toBe(2);
  });
});

describe("rows it cannot read", () => {
  const csv = [
    "Date,Description,Withdrawal,Deposit",
    "01/04/2026,Good row,,1000",
    "not-a-date,Bad date,,500",
    "02/04/2026,,,500",
    "03/04/2026,Zero row,0,0",
    "04/04/2026,Another good row,250,",
  ].join("\n");

  it("imports what it can and reports the rest by line number", () => {
    // A statement with one bad line is still worth importing. Refusing the
    // whole file sends somebody to edit a CSV by hand, which is how figures get
    // changed.
    const { rows, errors } = parseBankStatement(csv);
    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(3);
    expect(errors.map((error) => error.lineNumber)).toEqual([3, 4, 5]);
  });

  it("names what was wrong with each", () => {
    const { errors } = parseBankStatement(csv);
    expect(errors[0]?.message).toMatch(/date/i);
    expect(errors[1]?.message).toMatch(/description/i);
    expect(errors[2]?.message).toMatch(/zero/i);
  });
});

describe("a row with unquoted commas in a number", () => {
  it("refuses it rather than reading an amount from the wrong column", () => {
    // Some exports write 1,25,000.00 without quoting it, which is not valid
    // CSV: the row gains two cells and every column after the number shifts
    // left. Reading that row would produce a wrong figure that looks entirely
    // plausible — the one outcome worth failing loudly for.
    const { rows, errors } = parseBankStatement(
      [
        "Date,Description,Withdrawal,Deposit,Balance",
        "01/04/2026,Cash deposit,,25000.00,1,25,000.00",
      ].join("\n"),
    );

    expect(rows).toHaveLength(0);
    expect(errors[0]?.message).toMatch(/quoted/i);
    expect(errors[0]?.message).toMatch(/7 values where the header has 5/);
  });

  it("still accepts rows padded with trailing empty cells", () => {
    // Padding every row to a fixed width is common and harmless — it must not
    // be mistaken for the fault above.
    const { rows, errors } = parseBankStatement(
      [
        "Date,Description,Withdrawal,Deposit",
        "01/04/2026,Cash deposit,,25000.00,,",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

describe("a file that is not a statement", () => {
  it("refuses one with no date column", () => {
    expect(() =>
      parseBankStatement("Particulars,Withdrawal\nRent,1000"),
    ).toThrow(StatementFormatError);
  });

  it("refuses one with no amount columns, naming what it expected", () => {
    expect(() => parseBankStatement("Date,Narration\n01/04/2026,Rent")).toThrow(
      /Withdrawal and Deposit/i,
    );
  });

  it("refuses an empty file", () => {
    expect(() => parseBankStatement("")).toThrow(StatementFormatError);
  });
});
