// @flow
import { Document, Collection, User, Event } from "../models";
import { sequelize } from "../sequelize";

export default async function documentMover({
  user,
  document,
  collectionId,
  parentDocumentId,
  index,
  ip,
}: {
  user: User,
  document: Document,
  collectionId: string,
  parentDocumentId?: string,
  index?: number,
  ip: string,
}) {
  let transaction;
  const result = { collections: [], documents: [] };
  const collectionChanged = collectionId !== document.collectionId;

  if (document.template) {
    if (!collectionChanged) {
      return result;
    }

    document.collectionId = collectionId;
    document.parentDocumentId = null;

    await document.save();
    result.documents.push(document);
  } else {
    try {
      transaction = await sequelize.transaction();

      // remove from original collection
      const collection = await Collection.findByPk(document.collectionId, {
        transaction,
        paranoid: false,
      });
      const documentJson = await collection.removeDocumentInStructure(
        document,
        {
          save: false,
        }
      );

      // if the collection is the same then it will get saved below, this
      // line prevents a pointless intermediate save from occurring.
      if (collectionChanged) await collection.save({ transaction });

      // add to new collection (may be the same)
      document.collectionId = collectionId;
      document.parentDocumentId = parentDocumentId;

      const newCollection: Collection = collectionChanged
        ? await Collection.findByPk(collectionId, { transaction })
        : collection;
      await newCollection.addDocumentToStructure(document, index, {
        documentJson,
      });
      result.collections.push(collection);

      // if collection does not remain the same loop through children and change their
      // collectionId too. This includes archived children, otherwise their collection
      // would be wrong once restored.
      if (collectionChanged) {
        result.collections.push(newCollection);

        const loopChildren = async (documentId) => {
          const childDocuments = await Document.findAll({
            where: { parentDocumentId: documentId },
          });

          await Promise.all(
            childDocuments.map(async (child) => {
              await loopChildren(child.id);
              await child.update({ collectionId }, { transaction });
              child.collection = newCollection;
              result.documents.push(child);
            })
          );
        };

        await loopChildren(document.id);
      }

      await document.save({ transaction });
      result.documents.push(document);

      await transaction.commit();
    } catch (err) {
      if (transaction) {
        await transaction.rollback();
      }
      throw err;
    }
  }

  await Event.create({
    name: "documents.move",
    actorId: user.id,
    documentId: document.id,
    collectionId,
    teamId: document.teamId,
    data: {
      title: document.title,
      collectionIds: result.collections.map((c) => c.id),
      documentIds: result.documents.map((d) => d.id),
    },
    ip,
  });

  // we need to send all updated models back to the client
  return result;
}
