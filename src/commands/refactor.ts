import * as as from "../analysis/analysis_server_types";
import * as editors from "../editors";
import * as vs from "vscode";
import { Analyzer } from "../analysis/analyzer";
import { unique } from "../utils";

export const REFACTOR_FAILED_DOC_MODIFIED = "This refactor cannot be applied because the document has changed.";
export const REFACTOR_ANYWAY = "Refactor Anyway";

const refactorOptions: { [key: string]: (feedback: as.RefactoringFeedback) => as.RefactoringOptions } = {
	EXTRACT_METHOD: getExtractMethodArgs,
};

export class RefactorCommands implements vs.Disposable {
	private context: vs.ExtensionContext;
	private analyzer: Analyzer;
	private commands: vs.Disposable[] = [];

	constructor(context: vs.ExtensionContext, analyzer: Analyzer) {
		this.context = context;
		this.analyzer = analyzer;

		this.commands.push(
			vs.commands.registerCommand("_dart.performRefactor", this.performRefactor, this),
		);
	}

	private async performRefactor(document: vs.TextDocument, range: vs.Range, refactorKind: as.RefactoringKind): Promise<void> {
		// Ensure the document is still valid.
		if (!document || document.isClosed)
			return;

		const originalDocumentVersion = document.version;

		// Validate that there are no problems if we execute this refactor.
		const validationResult = await this.getRefactor(document, refactorKind, range, true);
		if (this.shouldAbortRefactor(validationResult))
			return;

		// Request the options from the user.
		const options = await refactorOptions[refactorKind](validationResult.feedback);
		if (!options)
			return;

		// Send the request for the refactor edits and prompt to apply if required.
		const editResult = await this.getRefactor(document, refactorKind, range, false, options);
		const applyEdits = await this.shouldApplyEdits(editResult, document, originalDocumentVersion);

		if (applyEdits)
			await vs.commands.executeCommand("_dart.applySourceChange", document, editResult.change);
	}

	private getRefactor(
		document: vs.TextDocument,
		refactorKind: as.RefactoringKind,
		range: vs.Range,
		validateOnly: boolean,
		options?: as.RefactoringOptions)
		: Thenable<as.EditGetRefactoringResponse> {
		return this.analyzer.editGetRefactoring({
			file: document.fileName,
			kind: refactorKind,
			length: document.offsetAt(range.end) - document.offsetAt(range.start),
			offset: document.offsetAt(range.start),
			options,
			validateOnly,
		});
	}

	private shouldAbortRefactor(validationResult: as.EditGetRefactoringResponse) {
		const validationProblems = validationResult.initialProblems
			.concat(validationResult.optionsProblems)
			.concat(validationResult.finalProblems)
			.filter((e) => e.severity === "FATAL");

		if (validationProblems.length) {
			vs.window.showErrorMessage(validationProblems[0].message);
			return true;
		}
		return false;
	}

	private async shouldApplyEdits(editResult: as.EditGetRefactoringResponse, document: vs.TextDocument, originalDocumentVersion: number) {
		const allProblems = editResult.initialProblems
			.concat(editResult.optionsProblems)
			.concat(editResult.finalProblems);

		const editFatals = allProblems.filter((e) => e.severity === "FATAL");
		const editWarnings = allProblems.filter((e) => e.severity === "ERROR" || e.severity === "WARNING");
		const hasErrors = !!allProblems.find((e) => e.severity === "ERROR");

		// Fatal errors can never be applied, just tell the user and quit.
		if (editFatals.length) {
			vs.window.showErrorMessage(unique(editFatals.map((e) => e.message)).join("\n\n") + "\n\nYour refactor was not applied.");
			return false;
		}

		// If we somehow got here with no change, we also cannot apply them.
		if (!editResult.change)
			return false;

		let applyEdits = true;

		// If we have warnings/errors, the user can decide whether to go ahead.
		if (editWarnings.length) {
			const show = hasErrors ? vs.window.showErrorMessage : vs.window.showWarningMessage;
			applyEdits = (REFACTOR_ANYWAY === await show(unique(editWarnings.map((w) => w.message)).join("\n\n"), REFACTOR_ANYWAY));
		}

		// If we're trying to apply changes but the document is modified, we have to quit.
		if (applyEdits && document.version !== originalDocumentVersion) {
			vs.window.showErrorMessage(REFACTOR_FAILED_DOC_MODIFIED);
			return false;
		}

		return applyEdits;
	}

	public dispose(): any {
		for (const command of this.commands)
			command.dispose();
	}
}

async function getExtractMethodArgs(f: as.RefactoringFeedback): Promise<as.RefactoringOptions> {
	const feedback = f as as.ExtractMethodFeedback;
	const suggestedName = feedback.names && feedback.names.length ? feedback.names[0] : undefined;
	const name = await vs.window.showInputBox({ prompt: "Enter a name for the method", value: suggestedName });

	if (!name)
		return;

	return {
		createGetter: false,
		extractAll: false,
		name,
		parameters: feedback.parameters,
		returnType: feedback.returnType,
	};
}
