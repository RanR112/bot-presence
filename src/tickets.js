import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { JsonStore } from './jsonStore.js';
import { logger } from './logger.js';

export const IDS = {
  start: 'verify:start',
  modal: 'verify:modal',
  approve: 'verify:approve',
  reject: 'verify:reject',
};

// Channel info komunitas -- tempat panduan "Cara Klaim History Coin" (lengkap
// dengan screenshot langkah-langkahnya) diposting, supaya panel & tiket cukup
// mengarahkan ke sana daripada mengulang instruksinya di sini.
const INFO_CHANNEL_ID = '1554521502416773250';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

const isImage = (attachment) =>
  attachment.contentType?.startsWith('image/') || IMAGE_EXT.test(attachment.name ?? '');

export function buildPanel() {
  const embed = new EmbedBuilder()
    .setTitle('🎁 Klaim Role Gift Leaderboard')
    .setColor(0x4a90d9)
    .setDescription(
      [
        'Sudah pernah kirim gift saat LIVE? Kamu bisa klaim role sesuai total coin yang sudah kamu kirim.',
        '',
        '**Cara klaim:**',
        '1. Klik tombol **Verifikasi Akun TikTok** di bawah.',
        '2. Isi nama dan username TikTok kamu.',
        '3. Kirim **screenshot bukti** kepemilikan akun di channel tiket yang otomatis dibuat.',
        '4. Tunggu moderator memverifikasi.',
        '',
        'Setelah disetujui, role akan diberikan otomatis sesuai total coin kamu, dan terus diperbarui saat kamu kirim gift lagi.',
        '',
        `**Punya riwayat gift dari sebelum bot ini aktif?** Bisa diklaim juga di channel tiket yang sama, lihat tata caranya di <#${INFO_CHANNEL_ID}>.`,
      ].join('\n'),
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.start)
      .setLabel('Verifikasi Akun TikTok')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row] };
}

export class TicketManager {
  #client;
  #store;
  #roles;
  #config;
  #tickets;

  constructor({ client, store, roles, config, filePath }) {
    this.#client = client;
    this.#store = store;
    this.#roles = roles;
    this.#config = config;
    this.#tickets = new JsonStore(filePath, { open: {} });
  }

  async load() {
    await this.#tickets.load();
    this.#tickets.get().open ??= {};
  }

  flush() {
    return this.#tickets.flush();
  }

  #all() {
    return this.#tickets.get().open;
  }

  async handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId === IDS.start) {
      return this.#openModal(interaction);
    }
    if (interaction.isModalSubmit() && interaction.customId === IDS.modal) {
      return this.#createTicket(interaction);
    }
    if (interaction.isButton() && interaction.customId.startsWith(`${IDS.approve}:`)) {
      return this.#decide(interaction, true);
    }
    if (interaction.isButton() && interaction.customId.startsWith(`${IDS.reject}:`)) {
      return this.#decide(interaction, false);
    }
    return undefined;
  }

  async #openModal(interaction) {
    const existing = this.#store.linkForDiscordId(interaction.user.id);
    if (existing) {
      await interaction.reply({
        content: `Akun kamu sudah terverifikasi sebagai **@${existing.displayId}**. Hubungi moderator kalau perlu diubah.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const openTicket = Object.entries(this.#all()).find(
      ([, ticket]) => ticket.discordId === interaction.user.id && !ticket.decidedAt,
    );
    if (openTicket) {
      await interaction.reply({
        content: `Kamu masih punya tiket yang sedang diproses: <#${openTicket[0]}>.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const modal = new ModalBuilder().setCustomId(IDS.modal).setTitle('Verifikasi Akun TikTok');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('realName')
          .setLabel('Nama kamu')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(80)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('tiktokUsername')
          .setLabel('Username TikTok (tanpa @)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(50)
          .setRequired(true),
      ),
    );

    await interaction.showModal(modal);
  }

  async #createTicket(interaction) {
    const realName = interaction.fields.getTextInputValue('realName').trim();
    const displayId = interaction.fields
      .getTextInputValue('tiktokUsername')
      .trim()
      .replace(/^@/, '');

    if (!displayId) {
      await interaction.reply({
        content: 'Username TikTok tidak boleh kosong.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const taken = this.#store.linkForDisplayId(displayId);
    if (taken) {
      await interaction.reply({
        content: `Username **@${displayId}** sudah diklaim member lain. Hubungi moderator kalau ini keliru.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const overwrites = [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: this.#config.tickets.modRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];

    const channel = await guild.channels.create({
      name: `verif-${interaction.user.username}`.slice(0, 90),
      type: ChannelType.GuildText,
      parent: this.#config.tickets.categoryId ?? undefined,
      permissionOverwrites: overwrites,
      reason: `Tiket verifikasi TikTok untuk ${interaction.user.tag}`,
    });

    this.#all()[channel.id] = {
      discordId: interaction.user.id,
      realName,
      displayId,
      createdAt: new Date().toISOString(),
      screenshotUrl: null,
      submittedAt: null,
      decidedAt: null,
      decision: null,
      modId: null,
    };
    this.#tickets.scheduleSave();

    const embed = new EmbedBuilder()
      .setTitle('🎫 Tiket Verifikasi')
      .setColor(0x5865f2)
      .setDescription(
        [
          `Halo <@${interaction.user.id}>, data kamu sudah tercatat:`,
          `**Nama:** ${realName}`,
          `**Username TikTok:** @${displayId}`,
          '',
          '**Langkah terakhir:** kirim **screenshot bukti** kepemilikan akun TikTok tersebut di channel ini (misalnya tangkapan layar profil kamu saat sedang login).',
          '',
          `**Punya riwayat gift dari sebelum bot ini aktif dan mau diklaim juga?** Bisa sekalian di channel ini juga, lihat tata caranya di <#${INFO_CHANNEL_ID}>.`,
          '',
          'Setelah screenshot terkirim, moderator akan otomatis diberi tahu.',
        ].join('\n'),
      );

    await channel.send({
      content: `<@${interaction.user.id}>`,
      embeds: [embed],
    });
    await interaction.editReply({
      content: `Tiket kamu sudah dibuat: <#${channel.id}>`,
    });
  }

  /** Dipanggil untuk setiap pesan di guild; hanya pesan di channel tiket yang diproses. */
  async handleMessage(message) {
    const ticket = this.#all()[message.channelId];
    if (!ticket || ticket.submittedAt || ticket.decidedAt) return;
    if (message.author.id !== ticket.discordId) return;

    const screenshot = message.attachments.find(isImage);
    if (!screenshot) return;

    ticket.screenshotUrl = screenshot.url;
    ticket.submittedAt = new Date().toISOString();
    this.#tickets.scheduleSave();

    await message.reply('✅ Screenshot diterima. Moderator sudah diberi tahu, mohon tunggu.');
    await this.#notifyModerators(message.channelId, ticket);
  }

  async #notifyModerators(channelId, ticket) {
    const channel = await this.#client.channels
      .fetch(this.#config.tickets.modNotifyChannelId)
      .catch(() => null);
    if (!channel?.isTextBased()) {
      logger.warn('Channel notifikasi moderator tidak ditemukan.');
      return;
    }

    const observed = this.#store.totalsForLink({ displayId: ticket.displayId });
    const embed = new EmbedBuilder()
      .setTitle('🔔 Permintaan Verifikasi Baru')
      .setColor(0xfaa61a)
      .addFields(
        { name: 'Member', value: `<@${ticket.discordId}>`, inline: true },
        { name: 'Nama', value: ticket.realName, inline: true },
        {
          name: 'Username TikTok',
          value: `@${ticket.displayId}`,
          inline: true,
        },
        {
          name: 'Coin tercatat bot',
          value: observed.allTime > 0 ? `${observed.allTime}` : 'Belum ada data',
          inline: true,
        },
        { name: 'Tiket', value: `<#${channelId}>`, inline: true },
      )
      .setImage(ticket.screenshotUrl)
      .setFooter({
        text: 'Cek juga channel tiket -- kalau ada screenshot Riwayat Koin tambahan, pakai >addcoin setelah menyetujui.',
      })
      .setTimestamp(new Date());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.approve}:${channelId}`)
        .setLabel('Setujui')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${IDS.reject}:${channelId}`)
        .setLabel('Tolak')
        .setStyle(ButtonStyle.Danger),
    );

    await channel.send({
      content: `<@&${this.#config.tickets.modRoleId}>`,
      embeds: [embed],
      components: [row],
    });
  }

  async #decide(interaction, approved) {
    const channelId = interaction.customId.split(':')[2];
    const ticket = this.#all()[channelId];

    if (!ticket) {
      await interaction.reply({
        content: 'Tiket ini sudah tidak ada.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (ticket.decidedAt) {
      await interaction.reply({
        content: `Tiket ini sudah diputuskan (${ticket.decision}).`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.member.roles.cache.has(this.#config.tickets.modRoleId)) {
      await interaction.reply({
        content: 'Hanya moderator yang bisa memutuskan.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferUpdate();

    ticket.decidedAt = new Date().toISOString();
    ticket.decision = approved ? 'approved' : 'rejected';
    ticket.modId = interaction.user.id;
    this.#tickets.scheduleSave();

    let grantedText = '';
    if (approved) {
      this.#store.createLink(ticket.discordId, {
        displayId: ticket.displayId,
        realName: ticket.realName,
      });
      const totals = this.#store.totalsForLink(this.#store.linkForDiscordId(ticket.discordId));
      const granted = await this.#roles.syncMilestones(ticket.discordId, totals.allTime);
      grantedText =
        granted.length > 0
          ? `\nRole yang kamu dapat: ${granted.map((m) => `**${m.name}**`).join(', ')}`
          : '\nBelum ada role milestone yang tercapai. Kirim gift lagi saat LIVE untuk naik tingkat.';
    }

    const ticketChannel = await this.#client.channels.fetch(channelId).catch(() => null);
    if (ticketChannel?.isTextBased()) {
      const embed = new EmbedBuilder()
        .setTitle(approved ? '✅ Verifikasi Disetujui' : '❌ Verifikasi Ditolak')
        .setColor(approved ? 0x57f287 : 0xed4245)
        .setDescription(
          approved
            ? `Akun **@${ticket.displayId}** berhasil ditautkan.${grantedText}`
            : 'Verifikasi kamu ditolak. Hubungi moderator kalau ingin mengajukan ulang.',
        )
        .setFooter({
          text: `Tiket ditutup otomatis ${this.#config.tickets.closeAfterHours} jam lagi.`,
        });
      await ticketChannel.send({
        content: `<@${ticket.discordId}>`,
        embeds: [embed],
      });
    }

    await interaction.message
      .edit({
        components: [],
        content: `${approved ? '✅ Disetujui' : '❌ Ditolak'} oleh <@${interaction.user.id}>`,
      })
      .catch(() => {});
  }

  /** Menutup tiket yang sudah lewat batas waktu sejak keputusan moderator. */
  async sweep() {
    const cutoffMs = this.#config.tickets.closeAfterHours * 3600_000;
    const now = Date.now();

    for (const [channelId, ticket] of Object.entries(this.#all())) {
      if (!ticket.decidedAt) continue;
      if (now - Date.parse(ticket.decidedAt) < cutoffMs) continue;

      const channel = await this.#client.channels.fetch(channelId).catch(() => null);
      if (channel) {
        await channel
          .delete('Tiket verifikasi selesai')
          .catch((error) => logger.error(`Gagal menutup tiket ${channelId}: ${error.message}`));
      }
      delete this.#all()[channelId];
      this.#tickets.scheduleSave();
    }
  }
}
