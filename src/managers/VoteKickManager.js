import { Logger } from "../utils/Logger.js";

export class VoteKickManager {
    // groupJid -> pollData
    static activePolls = new Map();

    static async handleCommand(bot, text) {
        try {
            if (!bot.isGroup) {
                await bot.reply("⚠️ Este comando só funciona em grupos!");
                return;
            }

            const jid = bot.jid;

            if (this.activePolls.has(jid)) {
                await bot.reply("⚠️ Já existe uma votação de expulsão ativa neste grupo. Aguarde o término.");
                return;
            }

            const parts = text.split(" ");
            if (parts.length < 3) {
                await bot.reply("⚠️ Uso correto: !votekick <diferença min 3> <@usuario>");
                return;
            }

            const diffNeeded = parseInt(parts[1]);
            if (isNaN(diffNeeded) || diffNeeded < 3) {
                await bot.reply("⚠️ A diferença mínima de votos precisa ser pelo menos 3.");
                return;
            }

            const sock = bot.socket;
            const groupMetadata = await sock.groupMetadata(jid);

            let mentionedJidList = await bot.getMentionedJids();
            let targetJid;
            let targetParticipant;

            if (mentionedJidList.length > 0) {
                targetJid = mentionedJidList[0];
                targetParticipant = groupMetadata.participants.find(p => p.id === targetJid);
            } else {
                const targetText = parts.slice(2).join(" ");
                const targetNumber = targetText.replace(/\D/g, "");

                if (targetNumber.length >= 8) {
                    targetParticipant = groupMetadata.participants.find(p => p.id.replace(/\D/g, "").includes(targetNumber));
                    if (targetParticipant) {
                        targetJid = targetParticipant.id;
                    }
                }
            }

            if (!targetParticipant || !targetJid) {
                await bot.reply("⚠️ Você precisa mencionar a pessoa ou digitar o número corretamente. Ex: !votekick 3 @5511999999999");
                return;
            }

            let botJid = sock.user?.id || sock.authState?.creds?.me?.id;
            let botLid = sock.user?.lid || sock.authState?.creds?.me?.lid;

            const cleanJid = (id) => {
                if (!id) return null;
                return id.split(":")[0].split("@")[0].replace(/\D/g, "");
            };

            const botIdClean = cleanJid(botJid);
            const botLidClean = cleanJid(botLid);

            const botIsAdmin = groupMetadata.participants.find((p) => {
                const participantClean = cleanJid(p.id);
                return (participantClean === botIdClean || (botLidClean && participantClean === botLidClean)) && p.admin;
            });

            if (!botIsAdmin) {
                await bot.reply("⚠️ O bot precisa ser administrador do grupo para poder expulsar membros!");
                return;
            }

            if (targetParticipant.admin) {
                await bot.reply("⚠️ Não é possível iniciar uma votação contra um administrador.");
                return;
            }

            const pollText = `🚨 *VOTAÇÃO DE EXPULSÃO INICIADA* 🚨\n\n` +
                `Alvo: @${targetJid.split("@")[0]}\n` +
                `Diferença necessária (\`Sim\` - \`Não\`): ${diffNeeded}\n` +
                `Tempo: 1 minuto\n\n` +
                `Para votar, envie no grupo:\n` +
                `✅ *#sim*\n` +
                `❌ *#nao*`;

            await sock.sendMessage(jid, {
                text: pollText,
                mentions: [targetJid]
            });

            this.activePolls.set(jid, {
                jid,
                targetJid,
                diffNeeded,
                votes: new Map(), // voterJid -> "sim" | "nao"
                sock
            });

            Logger.info(`Votação de expulsão iniciada no grupo ${jid} contra ${targetJid}`);

            setTimeout(() => {
                this.evaluatePoll(jid);
            }, 60 * 1000);

        } catch (error) {
            Logger.error("Erro no comando votekick:", error);
            await bot.reply("❌ Ocorreu um erro ao iniciar a votação.");
        }
    }

    static async registerVote(bot, text) {
        if (!bot.isGroup || !text) return false;

        const jid = bot.jid;
        const pollData = this.activePolls.get(jid);

        if (!pollData) return false;

        const voterJid = bot.message.key.participant || bot.message.participant || bot.jid;
        const lower = text.trim().toLowerCase();

        if (lower === "#sim" || lower === "#não" || lower === "#nao") {
            const voteType = lower === "#sim" ? "sim" : "nao";
            pollData.votes.set(voterJid, voteType);

            if (voteType === "sim") {
                await bot.react("✅");
            } else {
                await bot.react("❌");
            }

            Logger.info(`[VoteKick] Voto registrado: ${voterJid} -> ${voteType}`);
            return true;
        }

        return false;
    }

    static async evaluatePoll(jid) {
        const pollData = this.activePolls.get(jid);
        if (!pollData) return;

        this.activePolls.delete(jid);

        try {
            let simVote = 0;
            let naoVote = 0;

            for (const vote of pollData.votes.values()) {
                if (vote === "sim") simVote++;
                if (vote === "nao") naoVote++;
            }

            Logger.info(`[VoteKick] Finalizando Votação no grupo ${jid}. Sim: ${simVote}. Não: ${naoVote}.`);

            const diff = simVote - naoVote;

            let announceResult = `📊 *Resultado da votação!*\n\n` +
                `Alvo: @${pollData.targetJid.split("@")[0]}\n` +
                `Sim: ${simVote}\nNão: ${naoVote}\n` +
                `Diferença atual: ${diff}\nDiferença necessária: ${pollData.diffNeeded}\n\n`;

            if (diff >= pollData.diffNeeded) {
                announceResult += `✅ *A diferença necessária foi alcançada.* O usuário será expulso.`;
                await pollData.sock.sendMessage(pollData.jid, {
                    text: announceResult,
                    mentions: [pollData.targetJid]
                });
                await pollData.sock.groupParticipantsUpdate(pollData.jid, [pollData.targetJid], "remove");
                Logger.info(`Usuário ${pollData.targetJid} expulso do grupo ${pollData.jid} via Votekick.`);
            } else {
                announceResult += `❌ *A diferença não foi alcançada.* O usuário não será expulso.`;
                await pollData.sock.sendMessage(pollData.jid, {
                    text: announceResult,
                    mentions: [pollData.targetJid]
                });
            }
        } catch (error) {
            Logger.error("Erro ao avaliar votação:", error);
        }
    }
}
