import { Injectable, OnModuleInit } from '@nestjs/common';
import { Wallet } from '@project-serum/anchor';
import { AddressLookupTableAccount, clusterApiUrl, ComputeBudgetProgram, Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction, TransactionExpiredBlockheightExceededError, TransactionInstruction, TransactionMessage, VersionedTransaction, VersionedTransactionResponse } from '@solana/web3.js';
import axios from 'axios';
import * as bs58 from 'bs58';
import fetch from 'cross-fetch';
import promiseRetry from "promise-retry";
import { retry } from 'rxjs';

@Injectable()
export class AppService implements OnModuleInit {

  usdtAddress = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
  usdtDecimals = 6
  peopleAddress = 'CobcsUrt3p91FwvULYKorQejgsm5HoQdv5T8RUZ6PnLA'
  peopleDecimals = 8

  connection = new Connection(clusterApiUrl("mainnet-beta"), { commitment: "confirmed" });
  wallet = new Wallet(Keypair.fromSecretKey(bs58.decode('')));
  walletPayFee = new Wallet(Keypair.fromSecretKey(bs58.decode('')));
  wait = (time: number) =>
    new Promise((resolve) => setTimeout(resolve, time));

  async onModuleInit() {
    await this.swapWithoutPayer()
  }

  async swapWithPayer() {
    const quoteResponse = await this.getRouteForSwap(this.usdtAddress, this.peopleAddress, 0.1 * Math.pow(10, this.usdtDecimals))
    console.log('quoteResponse: ', quoteResponse)

    const instructions = await this.getInstruction(quoteResponse)
    if (instructions.error) {
      throw new Error("Failed to get swap instructions: " + instructions.error);
    }

    console.log('instructions:', instructions)

    const {
      tokenLedgerInstruction, // If you are using `useTokenLedger = true`.
      computeBudgetInstructions, // The necessary instructions to setup the compute budget.
      setupInstructions, // Setup missing ATA for the users.
      swapInstruction: swapInstructionPayload, // The actual swap instruction.
      cleanupInstruction, // Unwrap the SOL if `wrapAndUnwrapSol = true`.
      addressLookupTableAddresses, // The lookup table addresses that you can use if you are using versioned transaction.
    } = instructions;

    const deserializeInstruction = (instruction) => {
      return new TransactionInstruction({
        programId: new PublicKey(instruction.programId),
        keys: instruction.accounts.map((key) => ({
          pubkey: new PublicKey(key.pubkey),
          isSigner: key.isSigner,
          isWritable: key.isWritable,
        })),
        data: Buffer.from(instruction.data, "base64"),
      });
    };

    const getAddressLookupTableAccounts = async (
      keys: string[]
    ): Promise<AddressLookupTableAccount[]> => {
      const addressLookupTableAccountInfos =
        await this.connection.getMultipleAccountsInfo(
          keys.map((key) => new PublicKey(key))
        );

      return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
        const addressLookupTableAddress = keys[index];
        if (accountInfo) {
          const addressLookupTableAccount = new AddressLookupTableAccount({
            key: new PublicKey(addressLookupTableAddress),
            state: AddressLookupTableAccount.deserialize(accountInfo.data),
          });
          acc.push(addressLookupTableAccount);
        }

        return acc;
      }, new Array<AddressLookupTableAccount>());
    };

    const addressLookupTableAccounts: AddressLookupTableAccount[] = [];

    addressLookupTableAccounts.push(
      ...(await getAddressLookupTableAccounts(addressLookupTableAddresses))
    );

    const blockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    const messageV0 = new TransactionMessage({
      payerKey: this.walletPayFee.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        deserializeInstruction(swapInstructionPayload),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 })
      ],
    }).compileToV0Message(addressLookupTableAccounts);
    const transaction = new VersionedTransaction(messageV0);

    // sign the transaction
    transaction.sign([this.wallet.payer, this.walletPayFee.payer]);

    // Simulate the transaction to check for errors
    try {
      const simulationResult = await this.connection.simulateTransaction(transaction);
      if (simulationResult.value.err) {
        console.error('Transaction simulation failed:', simulationResult.value);
        return;
      }
    } catch (error) {
      console.error('Transaction simulation error:', error);
      return;
    }

    // Execute the transaction
    const rawTransaction = transaction.serialize()
    const txid = await this.connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2
    });
    console.log('txid:', txid)
    const lastestBlock = await this.connection.getLatestBlockhash()
    console.log('blockhash', lastestBlock.blockhash)
    const result = await this.connection.confirmTransaction({
      lastValidBlockHeight: lastestBlock.lastValidBlockHeight,
      blockhash: lastestBlock.blockhash,
      signature: txid
    });
    console.log('result:', result)
  }

  async swapWithoutPayer() {
    const quoteResponse = await this.getRouteForSwap(this.usdtAddress, this.peopleAddress, 0.1 * Math.pow(10, this.usdtDecimals))
    console.log('quoteResponse: ', quoteResponse)

    const swapTransaction = await this.getSerializedTransaction(quoteResponse)
    console.log('swapTransaction: ', swapTransaction)

    // deserialize the transaction
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    console.log('transaction: ', transaction);

    // sign the transaction
    transaction.sign([this.wallet.payer]);

    // Execute the transaction
    const rawTransaction = transaction.serialize()
    const txid = await this.connection.sendRawTransaction(rawTransaction, {
      skipPreflight: true,
      maxRetries: 2
    });
    console.log('txid:', txid)

    const lastestBlock = await this.connection.getLatestBlockhash()
    console.log('blockhash', lastestBlock.blockhash)

    const result = await this.connection.confirmTransaction({
      lastValidBlockHeight: lastestBlock.lastValidBlockHeight,
      blockhash: lastestBlock.blockhash,
      signature: txid
    });
    console.log('result:', result)
  }

  // async transactionSenderAndConfirmationWaiter({
  //   connection,
  //   serializedTransaction,
  //   blockhashWithExpiryBlockHeight,
  // }): Promise<VersionedTransactionResponse | null> {
  //   const txid = await connection.sendRawTransaction(
  //     serializedTransaction,
  //     {
  //       skipPreflight: true,
  //     }
  //   );

  //   const controller = new AbortController();
  //   const abortSignal = controller.signal;

  //   const abortableResender = async () => {
  //     while (true) {
  //       await this.wait(2_000);
  //       if (abortSignal.aborted) return;
  //       try {
  //         await connection.sendRawTransaction(
  //           serializedTransaction,
  //           {
  //             skipPreflight: true,
  //           }
  //         );
  //       } catch (e) {
  //         console.warn(`Failed to resend transaction: ${e}`);
  //       }
  //     }
  //   };

  //   try {
  //     abortableResender();
  //     const lastValidBlockHeight =
  //       blockhashWithExpiryBlockHeight.lastValidBlockHeight - 150;

  //     // this would throw TransactionExpiredBlockheightExceededError
  //     await Promise.race([
  //       connection.confirmTransaction(
  //         {
  //           ...blockhashWithExpiryBlockHeight,
  //           // lastValidBlockHeight,
  //           signature: txid,
  //           abortSignal,
  //         },
  //         "confirmed"
  //       ),
  //       new Promise(async (resolve) => {
  //         // in case ws socket died
  //         while (!abortSignal.aborted) {
  //           await this.wait(2_000);
  //           const tx = await connection.getSignatureStatus(txid, {
  //             searchTransactionHistory: false,
  //           });
  //           if (tx?.value?.confirmationStatus === "confirmed") {
  //             resolve(tx);
  //           }
  //         }
  //       }),
  //     ]);
  //   } catch (e) {
  //     if (e instanceof TransactionExpiredBlockheightExceededError) {
  //       // we consume this error and getTransaction would return null
  //       console.log('0--------------')
  //       return null;
  //     } else {
  //       // invalid state from web3.js
  //       throw e;
  //     }
  //   } finally {
  //     controller.abort();
  //   }

  //   // in case rpc is not synced yet, we add some retries
  //   const response = await promiseRetry(async (retry) => {
  //     const response = await connection.getTransaction(txid, {
  //       commitment: "confirmed",
  //       maxSupportedTransactionVersion: 0,
  //     });
  //     if (!response) {
  //       retry(response);
  //     }
  //     console.log('txId: ', txid)
  //     return response;
  //   }, {retries: 5, minTimeout: 1e3})

  //   console.log('txId-2: ', txid)
  //   return response;
  // }

  async getRouteForSwap(inputMint, outputMint, amount, slippageBps = 50) {

    const quoteResponse = await (
      await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
      )
    ).json();

    return quoteResponse
  }

  async getSerializedTransaction(quoteResponse) {
    // get serialized transactions for the swap
    const { swapTransaction } = await (
      await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // quoteResponse from /quote api
          quoteResponse,
          // user public key to be used for the swap
          userPublicKey: this.wallet.publicKey.toString(),
          // auto wrap and unwrap SOL. default is true
          wrapAndUnwrapSol: true,
          // feeAccount is optional. Use if you want to charge a fee.  feeBps must have been passed in /quote API.
          // feeAccount,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 2000000
        })
      })
    ).json();

    return swapTransaction
  }

  async getInstruction(quoteResponse) {
    const instructions = await (
      await fetch('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          // quoteResponse from /quote api
          quoteResponse,
          userPublicKey: this.wallet.publicKey.toString(),
          // auto wrap and unwrap SOL. default is true
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true,
          prioritizationFeeLamports: 'auto',
        })
      })
    ).json();

    return instructions
  }


}
