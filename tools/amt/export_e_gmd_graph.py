#!/usr/bin/env python3
"""Export the pinned official E-GMD checkpoint as a float32 frozen graph.

Run this inside a TensorFlow 1.15 + Magenta environment checked out at
94529798dfbbb14c27ddfd76f23027dc8e2ce185. The resulting graph accepts the
official log-mel features and returns the native 8-hit onset/velocity classes.
"""

import argparse
import os

import tensorflow.compat.v1 as tf

from magenta.models.onsets_frames_transcription import configs
from magenta.models.onsets_frames_transcription import constants
from magenta.models.onsets_frames_transcription import drum_mappings
from magenta.models.onsets_frames_transcription import model_tpu


MAGENTA_COMMIT = "94529798dfbbb14c27ddfd76f23027dc8e2ce185"


def mapped_outputs(tensor, reduction):
    """Apply Magenta's official 8-hit prediction map to the 88 pitches."""
    outputs = []
    for pitch_class in drum_mappings.HIT_MAPS["8-hit"]:
        indices = [pitch - constants.MIN_MIDI_PITCH for pitch in pitch_class]
        selected = tf.gather(tensor, indices, axis=2)
        outputs.append(reduction(selected, axis=2))
    return tf.stack(outputs, axis=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint-dir", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    tf.disable_v2_behavior()
    config = configs.CONFIG_MAP["drums"]
    hparams = config.hparams
    hparams.batch_size = 1
    hparams.use_cudnn = False
    hparams.acoustic_rnn_dropout_keep_prob = 1.0
    hparams.combined_rnn_dropout_keep_prob = 1.0

    graph = tf.Graph()
    with graph.as_default():
        spec = tf.placeholder(
            tf.float32,
            shape=[1, None, hparams.spec_n_bins, 1],
            name="spec",
        )
        length = tf.reshape(tf.shape(spec)[1], [1], name="length")
        _, onset_logits, _, velocity_values = model_tpu.build_model(
            spec=spec,
            length=length,
            hparams=hparams,
            is_training=False,
        )
        onset_probabilities = tf.sigmoid(onset_logits)
        mapped_onsets = mapped_outputs(onset_probabilities, tf.reduce_max)
        mapped_velocities = mapped_outputs(velocity_values, tf.reduce_max)
        tf.identity(mapped_onsets, name="onset_probs")
        tf.identity(mapped_velocities, name="velocity_values")
        saver = tf.train.Saver()

    checkpoint = tf.train.latest_checkpoint(args.checkpoint_dir)
    if not checkpoint:
        raise RuntimeError("No TensorFlow checkpoint found in {}".format(args.checkpoint_dir))

    output_dir = os.path.dirname(os.path.abspath(args.output))
    if output_dir and not os.path.isdir(output_dir):
        os.makedirs(output_dir)
    with tf.Session(graph=graph) as session:
        saver.restore(session, checkpoint)
        frozen = tf.graph_util.convert_variables_to_constants(
            session,
            graph.as_graph_def(),
            ["onset_probs", "velocity_values"],
        )
        with tf.gfile.GFile(args.output, "wb") as handle:
            handle.write(frozen.SerializeToString())

    print("Exported {} variables from Magenta {} to {}".format(
        len(frozen.node), MAGENTA_COMMIT, args.output
    ))


if __name__ == "__main__":
    main()
