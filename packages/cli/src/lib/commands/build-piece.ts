import { Command } from "commander";
import { buildPiece, findPiece } from '../utils/piece-utils';
import chalk from "chalk";
import inquirer from "inquirer";

async function buildPieces(pieceName: string) {
    const pieceFolder = await findPiece(pieceName);
    // findPiece returns null when the folder doesn't exist — without this guard
    // buildPiece(null) crashes with a confusing ENOENT on "null/package.json".
    if (!pieceFolder) {
        console.error(chalk.red(`🚨 Piece '${pieceName}' not found under packages/integrations`));
        process.exit(1);
    }
    const { outputFolder } = await buildPiece(pieceFolder);
    console.info(chalk.green(`Piece '${pieceName}' built and packed successfully at ${outputFolder}.`));
}

export const buildPieceCommand = new Command('build')
    .description('Build pieces without publishing')
    .argument('[name]', 'name of the piece to build')
    .option('--name <pieceName>', 'name of the piece to build')
    .action(async (positionalName, options) => {
        const pieceName = positionalName ?? options.name;
        const questions = [
            {
                type: 'input',
                name: 'name',
                message: 'Enter the piece folder name',
                placeholder: 'google-drive',
                when() {
                    return !pieceName
                }
            },
        ];
        const answers = await inquirer.prompt(questions);
        await buildPieces(pieceName ?? answers.name);
    });
